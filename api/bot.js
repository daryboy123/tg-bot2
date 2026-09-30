const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;
  const GEMINI_API_BASE = API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
  const IMAGE_MODEL_NAME = 'gemini-3.1-flash-image';
  const textModelName = MODEL_NAME || 'grok-4.6';

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

    // 1. 获取图片
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

    // 2. 生图指令处理
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

      await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 正在为您生成 [${targetResolution}] 无损大图，请稍候捏~ ✨`);

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

        // 使用标准 FormData 发送无损原图文件（彻底解决发不出文件的问题）
        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('caption', `📦 [${targetResolution}] 官方纯正无损 PNG 原图文件`);
        
        const blob = new Blob([rawBuffer], { type: 'image/png' });
        formData.append('document', blob, `Artwork_${targetResolution}_${Date.now()}.png`);

        const docRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
          method: 'POST',
          body: formData
        });

        const docResult = await docRes.json();
        if (!docResult.ok) {
          throw new Error(`Telegram sendDocument error: ${docResult.description}`);
        }

      } catch (imgError) {
        console.error('Image Gen Error:', imgError);
        await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 生图或发送失败惹：${imgError.message} (T_T)`);
      }

      return res.status(200).json({ ok: true });
    }

    // 3. 文本聊天
    if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
    const history = chatHistories.get(chatId);
    history.push({ role: 'user', content: userText });
    if (history.length > 10) history.splice(0, history.length - 10);

    const aiResponse = await fetch(`${GEMINI_API_BASE}/models/${textModelName}:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: history.map(h => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }]
        }))
      })
    });

    const aiData = await aiResponse.json();
    const replyText = aiData.candidates?.[0]?.content?.parts?.[0]?.text || '呜呜，暂时没有收到回复呢 (T_T)';
    
    history.push({ role: 'model', content: replyText });
    await sendTelegramMessage(BOT_TOKEN, chatId, replyText);

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
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}
