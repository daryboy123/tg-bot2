export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;

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
      // 获取文本或图片附带的说明文字 (Caption)
      const userText = update.message.text || update.message.caption || '';
      let imageUrl = null;

      // 1. 如果用户发送了图片，自动获取最高清的图片并转换为 Base64
      if (update.message.photo && update.message.photo.length > 0) {
        const photo = update.message.photo[update.message.photo.length - 1];
        const fileId = photo.file_id;

        // 向 Telegram 请求文件的下载路径
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const fileData = await fileRes.json();
        
        if (fileData.ok) {
          const filePath = fileData.result.file_path;
          const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
          
          // 下载图片并转为 Data URL 格式
          const imgRes = await fetch(downloadUrl);
          const arrayBuffer = await imgRes.arrayBuffer();
          const base64Image = Buffer.from(arrayBuffer).toString('base64');
          imageUrl = `data:image/jpeg;base64,${base64Image}`;
        }
      }

      // 如果既没有文字也没有图片，直接返回
      if (!userText && !imageUrl) {
        return res.status(200).json({ ok: true });
      }

      console.log(`Processing message from ${chatId}, has image: ${!!imageUrl}`);

      // 2. 构造多模态或纯文本的 AI 请求体
      let messages = [];
      if (imageUrl) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: userText || '请帮我看看这张图片。' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        });
      } else {
        messages.push({
          role: 'user',
          content: userText
        });
      }

      // 3. 调用 AI 接口
      const aiResponse = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: messages
        })
      });

      const aiData = await aiResponse.json();
      const replyText = aiData.choices?.[0]?.message?.content || '抱歉，AI 暂时没有返回内容。';

      // 4. 将 AI 的回复发送回 Telegram
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: replyText
        })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Detailed Error Stack:', error);
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}
