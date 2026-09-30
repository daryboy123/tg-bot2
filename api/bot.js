// 内存中的简易多轮对话历史记录
const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;

  // 使用官方标准的 Gemini API 基础路径
  const GEMINI_API_BASE = API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
  const IMAGE_MODEL_NAME = 'gemini-3.1-flash-image';

  if (!BOT_TOKEN || !API_KEY) {
    console.error('Missing BOT_TOKEN or API_KEY');
    return res.status(500).json({ error: 'Missing credentials.' });
  }

  const textModelName = MODEL_NAME || 'grok-4.6';

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
          imageUrl = base64Image; // 纯 Base64 字符串
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
      // 分辨率解析
      // ==========================================
      const parseResolutionAndPrompt = (rawText, commandPrefix) => {
        let cleanText = rawText.replace(commandPrefix, '').trim();
        let targetResolutionTag = '1K';

        const resMatch = cleanText.match(/\b(512|1k|2k|4k)\b/i);
        if (resMatch) {
          targetResolutionTag = resMatch[1].toUpperCase();
          cleanText = cleanText.replace(resMatch[0], '').trim();
        }

        const finalPrompt = cleanText || 'A creative artwork';
        return {
          prompt: finalPrompt,
          resolutionTag: targetResolutionTag,
          enhancedPrompt: `${finalPrompt}, lossless PNG format, ultra-high definition resolution (${targetResolutionTag})`
        };
      };

      // 核心处理函数：接收 Base64 数据并强制无损 PNG 发送
      const sendImageResult = async (botToken, chatId, base64Data, caption, resolutionTag) => {
        const rawBuffer = Buffer.from(base64Data, 'base64');

        // 1. 发送预览图
        await sendTelegramPhotoBuffer(botToken, chatId, rawBuffer, `✨ [${resolutionTag}] 预览图: ${caption}`, `preview.png`);

        // 2. 发送无损原图文件（绝不压缩）
        const filename = `Artwork_${resolutionTag}_${Date.now()}.png`;
        await sendTelegramDocumentBuffer(botToken, chatId, rawBuffer, `📦 [${resolutionTag}] 官方纯正无损 PNG 原图文件`, filename);
      };

      // ==========================================
      // 3. 官方原生文生图 / 图生图逻辑
      // ==========================================
      if (userText.startsWith('/draw ') || userText.startsWith('/img2img') || imageUrl) {
        const prefix = userText.startsWith('/img2img') ? '/img2img' : (userText.startsWith('/draw') ? '/draw' : '');
        const { prompt, resolutionTag, enhancedPrompt } = parseResolutionAndPrompt(userText, prefix);
        
        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 人家正在调用官方 [${resolutionTag}] 原生接口为您绘制无损 PNG 大图，请稍候哦~ ✨`);

        try {
          // 构造官方标准的 Gemini 传参结构
          const parts = [{ text: enhancedPrompt }];
          if (imageUrl) {
            parts.push({
              inline_data: {
                mime_type: "image/jpeg",
                data: imageUrl
              }
            });
          }

          // 官方标准生成端点: models/{model}:generateContent
          const officialUrl = `${GEMINI_API_BASE}/models/${IMAGE_MODEL_NAME}:generateContent?key=${API_KEY}`;
          
          const imageApiRes = await fetch(officialUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: parts }],
              generationConfig: {
                responseMimeType: "image/png",
                resolution: resolutionTag
              }
            })
          });

          const imageApiData = await imageApiRes.json();
          if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
          }

          // 从官方返回的候选结构中提取内嵌的 Base64 图片数据
          const candidate = imageApiData.candidates?.[0];
          const responseParts = candidate?.content?.parts || [];
          
          let base64ImageResult = null;
          let textReply = '';

          for (const part of responseParts) {
            if (part.inlineData && part.inlineData.data) {
              base64ImageResult = part.inlineData.data;
            } else if (part.text) {
              textReply += part.text;
            }
          }

          if (!base64ImageResult) {
            throw new Error(`官方模型未返回二进制图片，文字回复: ${textReply || '无返回'}`);
          }

          await sendImageResult(BOT_TOKEN, chatId, base64ImageResult, prompt, resolutionTag);

        } catch (imgError) {
          console.error('Official Image Generation Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 呜呜……调用官方生图接口失败惹：${imgError.message} (T_T)`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 4. 常规多轮文字聊天
      // ==========================================
      if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
      }
      const history = chatHistories.get(chatId);

      history.push({ role: 'user', content: userText });
      if (history.length > 10) history.splice(0, history.length - 10);

      const systemInstruction = '你是一个温柔、贴心、说话带点撒娇语气的可爱美少女。你的回答总是充满关心，并且非常喜欢在每句话的结束语或句尾加上超级可爱的后缀（例如：~喵、呀、呢、呐、捏、(≧◡≦)、(๑>◡<๑) 等）。请始终保持这个可爱的语气和身份回复用户哦~';

      const aiResponse = await fetch(`${GEMINI_API_BASE}/models/${textModelName}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: typeof h.content === 'string' ? h.content : '图片' }]
          }))
        })
      });

      const aiData = await aiResponse.json();
      const replyText = aiData.candidates?.[0]?.content?.parts?.[0]?.text || '呜呜，人家暂时没有收到 AI 的返回内容呢 (T_T)';

      history.push({ role: 'model', content: replyText });
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
    Buffer.from(`--${boundary}--\r\n`)
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
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\.`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`--${boundary}--\r\n`)
  ];
  await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(bodyParts)
  });
}
