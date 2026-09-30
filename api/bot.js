export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;
  const GEMINI_API_BASE = API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
  const IMAGE_MODEL_NAME = 'gemini-3.1-flash-image';

  if (!BOT_TOKEN || !API_KEY) {
    return res.status(500).json({ error: 'Missing credentials.' });
  }

  try {
    const update = req.body;
    if (!update || !update.message) {
      return res.status(200).json({ ok: true });
    }

    const chatId = update.message.chat.id;
    let userText = update.message.text || update.message.caption || '';
    let imageUrl = null;

    let targetPhoto = null;
    if (update.message.photo && update.message.photo.length > 0) {
      targetPhoto = update.message.photo[update.message.photo.length - 1];
    } else if (update.message.reply_to_message && update.message.reply_to_message.photo) {
      const photos = update.message.reply_to_message.photo;
      targetPhoto = photos[photos.length - 1];
    }

    if (targetPhoto) {
      const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${targetPhoto.file_id}`);
      const fileData = await fileRes.json();
      if (fileData.ok) {
        const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
        const imgRes = await fetch(downloadUrl);
        const arrayBuffer = await imgRes.arrayBuffer();
        imageUrl = Buffer.from(arrayBuffer).toString('base64');
      }
    }

    if (!userText && !imageUrl) {
      return res.status(200).json({ ok: true });
    }

    if (userText.startsWith('/draw ') || userText.startsWith('/img2img') || imageUrl) {
      const prefix = userText.startsWith('/img2img') ? '/img2img' : (userText.startsWith('/draw') ? '/draw' : '');
      let cleanText = userText.replace(prefix, '').trim();
      let targetResolution = '1K';
      const resMatch = cleanText.match(/\b(512|1k|2k|4k)\b/i);
      if (resMatch) {
        targetResolution = resMatch[1].toUpperCase();
        cleanText = cleanText.replace(resMatch[0], '').trim();
      }
      const prompt = cleanText || 'A creative artwork';

      await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 正在绘制 [${targetResolution}] 大图并生成下载直链，请稍候捏~ ✨`);

      try {
        const parts = [{ text: `${prompt}, lossless PNG format, high resolution (${targetResolution})` }];
        if (imageUrl) {
          parts.push({ inline_data: { mime_type: "image/jpeg", data: imageUrl } });
        }

        const officialUrl = `${GEMINI_API_BASE}/models/${IMAGE_MODEL_NAME}:generateContent?key=${API_KEY}`;
        const imageApiRes = await fetch(officialUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: parts }],
            generationConfig: {
              responseMimeType: "image/png",
              resolution: targetResolution
            }
          })
        });

        const imageApiData = await imageApiRes.json();
        if (!imageApiRes.ok) {
          throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
        }

        const responseParts = imageApiData.candidates?.[0]?.content?.parts || [];
        let base64ImageResult = null;
        for (const part of responseParts) {
          if (part.inlineData && part.inlineData.data) {
            base64ImageResult = part.inlineData.data;
            break;
          }
        }

        if (!base64ImageResult) {
          throw new Error("模型未返回图片数据");
        }

        const rawBuffer = Buffer.from(base64ImageResult, 'base64');

        // 1. 利用 Telegram 的 sendDocument 接口把原图发到聊天里（同时 Telegram 会为该文件生成一个官方服务器的下载路径）
        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('caption', `📦 [${targetResolution}] 无损原图已生成`);
        
        const blob = new Blob([rawBuffer], { type: 'image/png' });
        formData.append('document', blob, `Artwork_${targetResolution}_${Date.now()}.png`);

        const docRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
          method: 'POST',
          body: formData
        });
        const docResult = await docRes.json();

        if (docResult.ok && docResult.result.document) {
          const fileId = docResult.result.document.file_id;
          
          // 2. 通过 getFile 获取 Telegram 服务器上的绝对直链
          const fileInfoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
          const fileInfoData = await fileInfoRes.json();
          
          if (fileInfoData.ok) {
            const filePath = fileInfoData.result.file_path;
            const directDownloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
            
            // 3. 把可以直接在浏览器打开的下载链接发给你！
            await sendTelegramMessage(BOT_TOKEN, chatId, `🔗 **无损原图下载直链已就绪**：\n\n[点击这里在任意浏览器中打开并下载原图](${directDownloadUrl})\n\n*(提示：链接直通 Telegram 官方服务器，绝对原画质、无任何二次压缩捏~)*`);
          }
        } else {
          throw new Error("获取 Telegram 文件直链失败");
        }

      } catch (imgError) {
        console.error('Image Gen Error:', imgError);
        await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 生成直链失败惹：${imgError.message} (T_T)`);
      }

      return res.status(200).json({ ok: true });
    }

    // 默认文本对话略过...
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Fatal Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function sendTelegramMessage(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
  });
}
