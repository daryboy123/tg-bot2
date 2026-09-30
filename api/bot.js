import { put } from '@vercel/blob';

// Node.js 20+. Configure the deployment timeout for image generation.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ status: 'Bot is running' });
  const { BOT_TOKEN, API_KEY, BLOB_READ_WRITE_TOKEN, WEBHOOK_SECRET } = process.env;
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!BOT_TOKEN || !API_KEY) return res.status(500).json({ error: 'Missing credentials' });
  const message = req.body?.message;
  if (!message) return res.status(200).json({ ok: true });
  const chatId = message.chat.id;
  const text = message.text || message.caption || '';
  const source = imageAttachment(message) || imageAttachment(message.reply_to_message);
  const command = /^\/(?:draw|img2img)(?:@\w+)?(?=\s|$)/i;
  // Resolution tokens also trigger drawing without /draw, including Chinese prompts.
  const resolutionPattern = /(?<![a-z0-9])(1k|2k|4k)(?![a-z0-9])/gi;
  const matches = [...text.matchAll(resolutionPattern)];
  if (!command.test(text) && !source && !matches.length) {
    // Insert your existing text-chat logic here, if applicable.
    return res.status(200).json({ ok: true });
  }

  try {
    const sizes = [...new Set(matches.map(match => match[1].toUpperCase()))];
    if (sizes.length > 1) throw new Error('请只指定一种分辨率：1K、2K 或 4K。');
    if (!BLOB_READ_WRITE_TOKEN) throw new Error('请先配置公共 Vercel Blob 存储和 BLOB_READ_WRITE_TOKEN，才能提供浏览器原图下载链接。');
    const imageSize = sizes[0] || '1K';
    const prompt = text.replace(command, '').replace(resolutionPattern, '').trim() || 'A creative artwork';
    await telegram(BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: `🎨 正在生成 ${imageSize} 原图，请稍候…` });
    const parts = [{ text: prompt }];
    if (source) parts.push({ inlineData: await downloadInput(BOT_TOKEN, source) });

    const configuredBase = (process.env.IMAGE_API_BASE || process.env.API_BASE || 'https://img-api.apinebula.ai/v1beta').replace(/\/+$/, '');
    const base = /^https:\/\/(?:img-api\.)?apinebula\.ai(?:\/v1(?:beta)?)?$/.test(configuredBase)
      ? 'https://img-api.apinebula.ai/v1beta' : configuredBase;
    const auth = new URL(base).hostname === 'generativelanguage.googleapis.com'
      ? { 'x-goog-api-key': API_KEY } : { Authorization: `Bearer ${API_KEY}` };
    const model = process.env.IMAGE_MODEL_NAME || 'gemini-3.1-flash-image';
    const response = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { imageSize }
        }
      }),
      signal: AbortSignal.timeout(240_000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`生图接口错误 (${response.status})：${data.error?.message || '请求失败'}`);
    const responseParts = data.candidates?.[0]?.content?.parts || [];
    const image = responseParts.filter(part => !part.thought).map(part => part.inlineData || part.inline_data)
      .find(inline => inline?.data && /^image\//i.test(inline.mimeType || inline.mime_type || ''));
    if (!image) throw new Error('模型未返回图片，请检查模型名称、图片生成权限或更换提示词。');
    const raw = Buffer.from(image.data, 'base64');
    const png = pngDimensions(raw);
    const dimensions = png || jpegDimensions(raw);
    if (!dimensions) throw new Error('接口返回的图片不是可识别的 PNG/JPEG，无法作为原图交付。');
    const format = png ? 'PNG' : 'JPEG';
    const mimeType = png ? 'image/png' : 'image/jpeg';
    const filename = `Artwork_${imageSize}_${dimensions.width}x${dimensions.height}_${Date.now()}.${png ? 'png' : 'jpg'}`;

    // Upload precisely the model's bytes: no decoding, resizing or transcoding.
    const stored = await put(`artworks/${filename}`, raw, {
      access: 'public', contentType: mimeType, addRandomSuffix: true,
      token: BLOB_READ_WRITE_TOKEN
    });
    const link = stored.downloadUrl || stored.url;
    await telegram(BOT_TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: `✅ ${format} 原始文件已保存\n请求档位：${imageSize}\n实际像素：${dimensions.width} × ${dimensions.height}\n大小：${(raw.length / 1024 / 1024).toFixed(2)} MB\n\n浏览器下载原图（中转接口返回的原始文件，未二次压缩）：\n${link}\n\n${png ? '' : '注意：中转返回的是 JPEG，不是 PNG。这里保留原始文件，不改格式冒充 PNG。\n'}链接托管在本机器人的文件存储中，并非 Google 官方域名。`,
      link_preview_options: { is_disabled: true }
    });

    // Telegram photo previews may be compressed; the document and URL stay original.
    if (process.env.SEND_PREVIEW !== 'false' && raw.length < 10 * 1024 * 1024 &&
        dimensions.width + dimensions.height <= 10000 &&
        Math.max(dimensions.width, dimensions.height) / Math.min(dimensions.width, dimensions.height) <= 20) {
      try {
        await uploadTelegram(BOT_TOKEN, 'sendPhoto', 'photo', chatId, raw, filename,
          '🖼 预览图（可能被 Telegram 压缩）；请使用下载链接或下方文件获取原图。', mimeType);
      } catch { /* Preview is optional; original delivery continues. */ }
    }
    if (raw.length < 49 * 1024 * 1024) {
      try {
        await uploadTelegram(BOT_TOKEN, 'sendDocument', 'document', chatId, raw, filename,
          `📦 ${format} 原始文件 · ${dimensions.width} × ${dimensions.height}`, mimeType);
      } catch {
        await telegram(BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: '原图文件发送到 Telegram 失败，请使用上方链接下载，原图已经保存。' });
      }
    } else {
      await telegram(BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: '原图较大，请使用上方浏览器链接下载。' });
    }
  } catch (error) {
    // Avoid exposing API keys or Telegram token-bearing input download URLs.
    let detail = String(error?.message || '未知错误');
    for (const secret of [BOT_TOKEN, API_KEY, BLOB_READ_WRITE_TOKEN]) {
      if (secret) detail = detail.split(secret).join('[隐藏]');
    }
    detail = detail.replace(/https?:\/\/\S+/g, '[链接已隐藏]');
    try {
      await telegram(BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: `❌ ${detail.slice(0, 1500)}` });
    } catch { console.error('Image request failed; Telegram notification also failed.'); }
  }
  // Acknowledge handled failures to avoid repeated paid generation from webhook retries.
  return res.status(200).json({ ok: true });
}

function pngDimensions(bytes) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

function imageAttachment(message) {
  if (message?.document?.mime_type?.startsWith('image/')) return message.document;
  return message?.photo?.at(-1);
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (frames.has(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      return width && height ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

async function downloadInput(token, attachment) {
  const file = await telegram(token, 'getFile', { file_id: attachment.file_id });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error('无法下载输入图片。');
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = pngDimensions(bytes) ? 'image/png' : (attachment.mime_type || 'image/jpeg');
  return { mimeType, data: bytes.toString('base64') };
}

async function telegram(token, method, payload) {
  const isForm = payload instanceof FormData;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    ...(isForm ? {} : { headers: { 'Content-Type': 'application/json' } }),
    body: isForm ? payload : JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} 失败：${result.description || response.status}`);
  return result.result;
}

async function uploadTelegram(token, method, field, chatId, raw, filename, caption, mimeType) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  if (field === 'document') form.append('disable_content_type_detection', 'true');
  form.append(field, new Blob([raw], { type: mimeType }), filename);
  return telegram(token, method, form);
}
