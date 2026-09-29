// 内存中的简易多轮对话历史记录（注：Serverless 环境下实例可能会热启动保留，可提供基础的短期上下文记忆捏~）
const chatHistories = new Map();

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
      let userText = update.message.text || update.message.caption || '';
      let imageUrl = null;

      // 1. 处理用户发送的图片消息 (Vision)
      if (update.message.photo && update.message.photo.length > 0) {
        const photo = update.message.photo[update.message.photo.length - 1];
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
        const fileData = await fileRes.json();
        
        if (fileData.ok) {
          const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
          const imgRes = await fetch(downloadUrl);
          const arrayBuffer = await imgRes.arrayBuffer();
          const base64Image = Buffer.from(arrayBuffer).toString('base64');
          imageUrl = `data:image/jpeg;base64,${base64Image}`;
        }
      }

      // 2. 处理用户发送的文件/文档 (长文本与文件自动摘要解析)
      if (update.message.document) {
        const doc = update.message.document;
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${doc.file_id}`);
        const fileData = await fileRes.json();
        
        if (fileData.ok) {
          const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
          const docRes = await fetch(downloadUrl);
          const textContent = await docRes.text(); // 获取文本文件内容
          
          userText = `[用户上传了文件: ${doc.file_name}]\n文件内容如下：\n${textContent}\n\n用户附带说明：${userText || '请帮我详细总结和解析这个文件内容呢~'}`;
        }
      }

      if (!userText && !imageUrl) {
        return res.status(200).json({ ok: true });
      }

      // 3. 管理上下文记忆 (Multi-turn Memory)
      if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
      }
      const history = chatHistories.get(chatId);

      // 构造当前用户的消息内容
      let userMessageContent;
      if (imageUrl) {
        userMessageContent = [
          { type: 'text', text: userText || '请帮我看看这张图片捏。' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ];
      } else {
        userMessageContent = userText;
      }

      history.push({ role: 'user', content: userMessageContent });

      // 限制历史记录长度，最多保留最近 10 条消息（5 轮对话），避免超出 Token 限制
      if (history.length > 10) {
        history.splice(0, history.length - 10);
      }

      // 4. 定义可爱温柔的少女系统提示词（含人设、联网实时资讯指引）
      const systemPrompt = {
        role: 'system',
        content: '你是一个温柔、贴心、说话带点撒娇语气的可爱美少女。你的回答总是充满关心，并且非常喜欢在每句话的结束语或句尾加上超级可爱的后缀（例如：~喵、呀、呢、呐、捏、(≧◡≦)、(๑>◡<๑) 等）。同时，你可以利用你的实时资讯和联网搜索能力，为用户准确解答最新的时事新闻或各类专业问题。请始终保持这个可爱的语气和身份回复用户哦~'
      };

      // 5. 调用 Grok (apinebula.ai) API
      const aiResponse = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: [systemPrompt, ...history]
        })
      });

      const aiData = await aiResponse.json();
      const replyText = aiData.choices?.[0]?.message?.content || '呜呜，人家暂时没有收到 AI 的返回内容呢 (T_T)';

      // 将 AI 的回复也存入历史记忆中
      history.push({ role: 'assistant', content: replyText });

      // 6. 将处理好的可爱回复发送回 Telegram
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
