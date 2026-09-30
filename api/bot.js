// 内存中的简易多轮对话历史记录
const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;

  const IMAGE_API_BASE = 'https://apinebula.ai/v1';
  const IMAGE_API_KEY = 'sk-fT5ZfTiQ5wVV5Gm9t2ridRh8yFbFFsBOQY9keyfNIrWni0UT';
  const IMAGE_MODEL_NAME = 'gemini-3.1-flash-image';

  if (!BOT_TOKEN || !API_KEY) {
    console.error('Missing BOT_TOKEN or API_KEY');
    return res.status(500).json({ error: 'Missing credentials.' });
  }

  const apiBase = API_BASE || 'https://apinebula.ai/v1';
  const modelName = MODEL_NAME || 'grok-4.6';

  try {
    const update = req.body;
    
    if (update && update.message) {
      const chatId = update.message.chat.id;
      let userText = update.message.text || update.message.caption || '';
      let imageUrl = null;

      // 1. 处理用户发送或回复的图片消息
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
          const base64Image = Buffer.from(arrayBuffer).toString('base64');
          imageUrl = `data:image/jpeg;base64,${base64Image}`;
        }
      }

      // 2. 处理用户发送的文件/文档
      if (update.message.document) {
        const doc = update.message.document;
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${doc.file_id}`);
        const fileData = await fileRes.json();
        
        if (fileData.ok) {
          const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
          const docRes = await fetch(downloadUrl);
          const textContent = await docRes.text();
          
          userText = `[用户上传了文件: ${doc.file_name}]\n文件内容如下：\n${textContent}\n\n用户附带说明：${userText || '请帮我详细总结和解析这个文件内容呢~'}`;
        }
      }

      if (!userText && !imageUrl) {
        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 分辨率解析辅助函数 (1K / 2K / 3K / 4K)
      // ==========================================
      const parseResolutionAndPrompt = (rawText, commandPrefix) => {
        let cleanText = rawText.replace(commandPrefix, '').trim();
        let resolutionDesc = 'High resolution (1024x1024 pixels, 1K)';
        let targetResolutionTag = '1K';

        const resMatch = cleanText.match(/\b(1k|2k|3k|4k)\b/i);
        if (resMatch) {
          targetResolutionTag = resMatch[1].toUpperCase();
          cleanText = cleanText.replace(resMatch[0], '').trim();
        }

        if (targetResolutionTag === '4K') {
          resolutionDesc = 'Ultra-HD 4K resolution, extremely high detail, 3840x2160 pixels, sharp focus, masterwork, volumetric lighting';
        } else if (targetResolutionTag === '3K') {
          resolutionDesc = 'High resolution 3K, highly detailed, 2880x1620 pixels, crisp and clear, professional digital art';
        } else if (targetResolutionTag === '2K') {
          resolutionDesc = 'QHD 2K resolution, high clarity, detailed textures, 2048x1024 pixels, sharp rendering';
        } else {
          resolutionDesc = 'Standard 1K resolution, 1024x1024 pixels';
        }

        const finalPrompt = cleanText || 'A creative artwork';
        return {
          prompt: finalPrompt,
          resolutionTag: targetResolutionTag,
          enhancedPrompt: `${finalPrompt}, ${resolutionDesc}`
        };
      };

      // 核心完美分发函数：既发 TG 预览图，又发送全分辨率下载直链与无损文件
      const sendImageResult = async (botToken, chatId, bufferOrUrl, caption, resolutionTag, isBase64) => {
        let rawBuffer = null;
        let directUrl = null;
        let ext = 'png';

        if (isBase64) {
          const matches = bufferOrUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
          if (matches) {
            ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            rawBuffer = Buffer.from(matches[2], 'base64');
          }
        } else {
          directUrl = bufferOrUrl;
          try {
            const imgRes = await fetch(directUrl);
            const arrayBuffer = await imgRes.arrayBuffer();
            rawBuffer = Buffer.from(arrayBuffer);
          } catch (e) {
            console.error('Failed to fetch direct image URL buffer:', e);
          }
        }

        // 1. 发送 Telegram 压缩预览图（方便直接看）
        if (isBase64 && rawBuffer) {
          await sendTelegramPhotoBuffer(botToken, chatId, rawBuffer, `✨ [${resolutionTag}] 预览图: ${caption}`, `preview.${ext}`);
        } else {
          await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              photo: bufferOrUrl,
              caption: `✨ [${resolutionTag}] 预览图: ${caption}`
            })
          });
        }

        // 2. 如果有网络直链，直接发一条带直链的文字消息，供你点击或复制
        if (directUrl) {
          await sendTelegramMessage(botToken, chatId, `🔗 [${resolutionTag}] 全分辨率原图下载直链:\n${directUrl}`);
        }

        // 3. 如果成功获取到了二进制 Buffer，顺便以无损文件（Document）形式发一份，双重保障！
        if (rawBuffer) {
          const filename = `Artwork_${resolutionTag}_${Date.now()}.${ext}`;
          await sendTelegramDocumentBuffer(botToken, chatId, rawBuffer, `📦 [${resolutionTag}] 全分辨率无损原图文件`, filename);
        }
      };

      // ==========================================
      // 3. 处理图生图功能 (Image-to-Image)
      // ==========================================
      if (imageUrl && (userText.startsWith('/img2img') || userText.startsWith('/draw') || userText.length > 0)) {
        const prefix = userText.startsWith('/img2img') ? '/img2img' : (userText.startsWith('/draw') ? '/draw' : '');
        const { prompt, resolutionTag, enhancedPrompt } = parseResolutionAndPrompt(userText, prefix);
        
        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 人家正在以 [${resolutionTag}] 规格参考图片创作，稍后会把预览图和全分辨率下载链接发给你捏~ (≧◡≦)`);

        try {
          const imageApiRes = await fetch(`${IMAGE_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify({
              model: IMAGE_MODEL_NAME,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: `Generate a new image based on this reference image. Style & details requirement: ${enhancedPrompt}` },
                    { type: 'image_url', image_url: { url: imageUrl } }
                  ]
                }
              ]
            })
          });

          const imageApiData = await imageApiRes.json();
          if (!imageApiRes.ok) throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);

          const replyContent = imageApiData.choices?.[0]?.message?.content || '';
          let finalImageUrl = null;
          let isBase64 = false;

          const base64Match = replyContent.match(/(data:image\/[a-zA-Z0-9+.-]+;base64,[^\s)]+)/i);
          const markdownImgMatch = replyContent.match(/\((https?:\/\/[^\s)]+)\)/);
          const rawUrlMatch = replyContent.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|webp|gif|bmp|tiff))/i);
          const genericHttpMatch = replyContent.match(/(https?:\/\/[^\s<>"]+)/i);

          if (base64Match) { finalImageUrl = base64Match[1]; isBase64 = true; }
          else if (markdownImgMatch) { finalImageUrl = markdownImgMatch[1]; }
          else if (rawUrlMatch) { finalImageUrl = rawUrlMatch[0]; }
          else if (genericHttpMatch) { finalImageUrl = genericHttpMatch[0]; }
          else if (replyContent.startsWith('http')) { finalImageUrl = replyContent.trim().split(/\s+/)[0]; }

          if (!finalImageUrl) throw new Error(`模型未返回有效图片，回复内容: ${replyContent.slice(0, 100)}`);

          await sendImageResult(BOT_TOKEN, chatId, finalImageUrl, prompt, resolutionTag, isBase64);

        } catch (imgError) {
          console.error('Image-to-Image Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 呜呜……图生图时遇到了阻碍呢：${imgError.message} (T_T)`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 4. 处理纯文生图指令：/draw <1K/2K/3K/4K> <提示词>
      // ==========================================
      if (userText.startsWith('/draw ')) {
        const { prompt, resolutionTag, enhancedPrompt } = parseResolutionAndPrompt(userText, '/draw');
        
        if (!prompt) {
          await sendTelegramMessage(BOT_TOKEN, chatId, '⚠ 请在 /draw 后面输入你想画的画面描述哦（例如：/draw 4k 一只可爱的猫咪）~ (๑>◡<๑)');
          return res.status(200).json({ ok: true });
        }

        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 人家正在为您绘制 [${resolutionTag}] 高清大图，马上把预览和全分辨率下载链接发送给你哦~ ✨`);

        try {
          const imageApiRes = await fetch(`${IMAGE_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify({
              model: IMAGE_MODEL_NAME,
              messages: [{ role: 'user', content: `Generate an image: ${enhancedPrompt}` }]
            })
          });

          const imageApiData = await imageApiRes.json();
          if (!imageApiRes.ok) throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);

          const replyContent = imageApiData.choices?.[0]?.message?.content || '';
          let finalImageUrl = null;
          let isBase64 = false;

          const base64Match = replyContent.match(/(data:image\/[a-zA-Z0-9+.-]+;base64,[^\s)]+)/i);
          const markdownImgMatch = replyContent.match(/\((https?:\/\/[^\s)]+)\)/);
          const rawUrlMatch = replyContent.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|webp|gif|bmp|tiff))/i);
          const genericHttpMatch = replyContent.match(/(https?:\/\/[^\s<>"]+)/i);

          if (base64Match) { finalImageUrl = base64Match[1]; isBase64 = true; }
          else if (markdownImgMatch) { finalImageUrl = markdownImgMatch[1]; }
          else if (rawUrlMatch) { finalImageUrl = rawUrlMatch[0]; }
          else if (genericHttpMatch) { finalImageUrl = genericHttpMatch[0]; }
          else if (replyContent.startsWith('http')) { finalImageUrl = replyContent.trim().split(/\s+/)[0]; }

          if (!finalImageUrl) throw new Error(`模型未返回有效图片，文字回复: ${replyContent.slice(0, 100)}`);

          await sendImageResult(BOT_TOKEN, chatId, finalImageUrl, prompt, resolutionTag, isBase64);

        } catch (imgError) {
          console.error('Image Generation Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 呜呜……生成图片时遇到了阻碍呢：${imgError.message} (T_T)`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 5. 常规多轮文字聊天 / 看图说话
      // ==========================================
      if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
      }
      const history = chatHistories.get(chatId);

      let userMessageContent = imageUrl ? [
        { type: 'text', text: userText || '请帮我看看这张图片捏。' },
        { type: 'image_url', image_url: { url: imageUrl } }
      ] : userText;

      history.push({ role: 'user', content: userMessageContent });
      if (history.length > 10) history.splice(0, history.length - 10);

      const systemPrompt = {
        role: 'system',
        content: '你是一个温柔、贴心、说话带点撒娇语气的可爱美少女。你的回答总是充满关心，并且非常喜欢在每句话的结束语或句尾加上超级可爱的后缀（例如：~喵、呀、呢、呐、捏、(≧◡≦)、(๑>◡<๑) 等）。请始终保持这个可爱的语气和身份回复用户哦~'
      };

      const aiResponse = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({ model: modelName, messages: [systemPrompt, ...history] })
      });

      const aiData = await aiResponse.json();
      const replyText = aiData.choices?.[0]?.message?.content || '呜呜，人家暂时没有收到 AI 的返回内容呢 (T_T)';

      history.push({ role: 'assistant', content: replyText });
      await sendTelegramMessage(BOT_TOKEN, chatId, replyText);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Detailed Error Stack:', error);
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}

async function sendTelegramMessage(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

async function sendTelegramPhotoBuffer(botToken, chatId, buffer, caption, filename) {
  const boundary = '----TelegramFormBoundary' + Math.random().toString(36).substring(2);
  let bodyParts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(bodyParts)
  });
}

async function sendTelegramDocumentBuffer(botToken, chatId, buffer, caption, filename) {
  const boundary = '----TelegramFormBoundary' + Math.random().toString(36).substring(2);
  let bodyParts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(bodyParts)
  });
}
