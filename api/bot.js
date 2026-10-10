// 内存中的简易多轮对话历史记录
const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running - Agnes AI connected' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;

  // 严格对齐官方文档的根路径
  const IMAGE_API_BASE = 'https://apihub.agnes-ai.com/v1';
  const IMAGE_API_KEY = 'sk-ozDsndDe9QaPCRibCGCpsx671obGruY9KBCThyWk8KvRPYBs';
  const IMAGE_MODEL_NAME = 'agnes-image-2.5-flash';

  if (!BOT_TOKEN || !API_KEY || !API_BASE || !MODEL_NAME) {
    console.error('Missing required chat environment variables.');
    return res.status(500).json({ error: 'Missing environment variables.' });
  }

  try {
    const update = req.body;
    
    if (update && update.message) {
      const chatId = update.message.chat.id;
      let userText = update.message.text || update.message.caption || '';
      let imageUrl = null;

      // 1. 处理用户发送或回复的图片
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

      // 尺寸比例与具体分辨率映射表（严格对照官方文档）
      const RESOLUTION_MAP = {
        '1:1': { '1k': '1024x1024', '2k': '2048x2048', '3k': '3072x3072', '4k': '4096x4096' },
        '3:4': { '1k': '864x1152',  '2k': '1728x2304', '3k': '2592x3456', '4k': '3456x4608' },
        '4:3': { '1k': '1152x864',  '2k': '2304x1728', '3k': '3456x2592', '4k': '4608x3456' },
        '16:9':{ '1k': '1312x736',  '2k': '2624x1472', '3k': '3936x2208', '4k': '5248x2944' },
        '9:16':{ '1k': '736x1312',  '2k': '1472x2624', '3k': '2208x3936', '4k': '2944x5248' },
        '2:3': { '1k': '832x1248',  '2k': '1664x2496', '3k': '2496x3744', '4k': '3328x4992' },
        '3:2': { '1k': '1248x832',  '2k': '2496x1664', '3k': '3744x2496', '4k': '4992x3328' },
        '21:9':{ '1k': '1568x672',  '2k': '3136x1344', '3k': '4704x2016', '4k': '6272x2688' }
      };

      function parseParams(text, prefix) {
        let cleanText = text.replace(prefix, '').trim();
        let ratio = '1:1';
        let tier = '1k';

        const ratioMatch = cleanText.match(/\b(1:1|3:4|4:3|16:9|9:16|2:3|3:2|21:9)\b/i);
        if (ratioMatch) {
          ratio = ratioMatch[1];
          cleanText = cleanText.replace(ratioMatch[0], '').trim();
        }

        const tierMatch = cleanText.match(/\b(1k|2k|3k|4k)\b/i);
        if (tierMatch) {
          tier = tierMatch[1].toLowerCase();
          cleanText = cleanText.replace(tierMatch[0], '').trim();
        }

        let exactSize = RESOLUTION_MAP[ratio]?.[tier] || '1024x1024';

        return { prompt: cleanText, ratio, tier, size: exactSize };
      }

      const isExplicitDrawCommand = userText.startsWith('/draw') || userText.startsWith('/img2img');
      const hasDrawKeywords = /画一张|帮我画|生成图片|画个|画一幅/i.test(userText);

      // ==========================================
      // 2. 处理图生图功能
      // ==========================================
      if (imageUrl && (isExplicitDrawCommand || hasDrawKeywords)) {
        const prefix = userText.startsWith('/img2img') ? '/img2img' : (userText.startsWith('/draw') ? '/draw' : '');
        const parsed = parseParams(userText, prefix);
        const prompt = parsed.prompt || 'Based on this image, generate a new artistic variation.';
        
        await sendTelegramMessage(BOT_TOKEN, chatId, `主人，我正在参考这张图片为您进行图生图创作哦 [比例: ${parsed.ratio}, 规格: ${parsed.tier.toUpperCase()}]：“${prompt}”, 请稍等一下下嘛~ (｡♥‿♥｡)`);

        try {
          const requestBody = {
            model: IMAGE_MODEL_NAME,
            prompt: prompt,
            image: imageUrl,
            size: parsed.size,
            n: 1,
            response_format: 'url'
          };

          const imageApiRes = await fetch(`${IMAGE_API_BASE}/images/generations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify(requestBody)
          });

          let imageApiData = await imageApiRes.json();
          
          if (!imageApiRes.ok && (parsed.tier === '3k' || parsed.tier === '4k')) {
            requestBody.size = RESOLUTION_MAP[parsed.ratio]['2k'];
            const retryRes = await fetch(`${IMAGE_API_BASE}/images/generations`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${IMAGE_API_KEY}`
              },
              body: JSON.stringify(requestBody)
            });
            imageApiData = await retryRes.json();
            if (retryRes.ok) {
              parsed.tier = '2k (降级)';
            } else {
              throw new Error(imageApiData.error?.message || `API error: ${retryRes.status}`);
            }
          } else if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
          }

          const finalImageUrl = imageApiData.data?.[0]?.url || imageApiData.data?.[0]?.b64_json || imageApiData.url;

          if (!finalImageUrl) {
            throw new Error(`生图接口未返回有效图片地址`);
          }

          const captionText = `提示词: ${prompt}\n比例: ${parsed.ratio} | 规格: ${parsed.tier.toUpperCase()} (${parsed.size})\n\n原图 PNG 链接: ${finalImageUrl}`;

          if (finalImageUrl.startsWith('data:image')) {
            const matches = finalImageUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
            if (!matches) {
              throw new Error('解析 Base64 图片数据失败');
            }
            const ext = matches[1];
            const buffer = Buffer.from(matches[2], 'base64');

            await sendTelegramPhotoBuffer(BOT_TOKEN, chatId, buffer, captionText, `image.${ext === 'jpeg' ? 'jpg' : ext}`);
          } else {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                photo: finalImageUrl,
                caption: captionText
              })
            });
          }

        } catch (imgError) {
          console.error('Image-to-Image Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `呜呜……图生图的时候遇到了一点小阻碍呢：${imgError.message} (＞﹏＜)`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 3. 处理纯文生图指令
      // ==========================================
      if (userText.startsWith('/draw ') || hasDrawKeywords) {
        const prefix = userText.startsWith('/draw ') ? '/draw' : '';
        const parsed = parseParams(userText, prefix);
        const prompt = parsed.prompt;
        
        if (!prompt) {
          await sendTelegramMessage(BOT_TOKEN, chatId, '主人，请在 /draw 后面输入你想画的画面描述哦（例如：/draw 赛博朋克 16:9 4k）~ (๑>◡<๑)');
          return res.status(200).json({ ok: true });
        }

        await sendTelegramMessage(BOT_TOKEN, chatId, `我正在为您构思并绘制 [比例: ${parsed.ratio}, 规格: ${parsed.tier.toUpperCase()}]：“${prompt}”, 请稍候哦~ (｡♥‿♥｡)`);

        try {
          const requestBody = {
            model: IMAGE_MODEL_NAME,
            prompt: prompt,
            size: parsed.size,
            n: 1,
            response_format: 'url'
          };

          let imageApiRes = await fetch(`${IMAGE_API_BASE}/images/generations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify(requestBody)
          });

          let imageApiData = await imageApiRes.json();

          if (!imageApiRes.ok && (parsed.tier === '3k' || parsed.tier === '4k')) {
            requestBody.size = RESOLUTION_MAP[parsed.ratio]['2k'];
            const retryRes = await fetch(`${IMAGE_API_BASE}/images/generations`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${IMAGE_API_KEY}`
              },
              body: JSON.stringify(requestBody)
            });
            imageApiData = await retryRes.json();
            if (retryRes.ok) {
              parsed.tier = '2k (降级)';
            } else {
              throw new Error(imageApiData.error?.message || `API error: ${retryRes.status}`);
            }
          } else if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
          }

          const finalImageUrl = imageApiData.data?.[0]?.url || imageApiData.data?.[0]?.b64_json || imageApiData.url;

          if (!finalImageUrl) {
            throw new Error(`生图接口未返回有效图片`);
          }

          const captionText = `提示词: ${prompt}\n比例: ${parsed.ratio} | 规格: ${parsed.tier.toUpperCase()} (${parsed.size})\n\n原图 PNG 链接: ${finalImageUrl}`;

          if (finalImageUrl.startsWith('data:image')) {
            const matches = finalImageUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
            if (!matches) {
              throw new Error('解析 Base64 图片数据失败');
            }
            const ext = matches[1];
            const buffer = Buffer.from(matches[2], 'base64');

            await sendTelegramPhotoBuffer(BOT_TOKEN, chatId, buffer, captionText, `image.${ext === 'jpeg' ? 'jpg' : ext}`);
          } else {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                photo: finalImageUrl,
                caption: captionText
              })
            });
          }

        } catch (imgError) {
          console.error('Image Generation Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `呜呜……生成图片时遇到了一点小问题呢：${imgError.message} (＞﹏＜)`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 4. 常规多轮文字聊天 / 看图问答 (优先使用 Google 搜索并提供可用图片直链)
      // ==========================================
      if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
      }
      const history = chatHistories.get(chatId);

      let userMessageContent;
      if (imageUrl) {
        userMessageContent = [
          { type: 'text', text: userText || '请帮我辨别这张图里的物体是什么。由于部分图床或维基图片打不开，请优先通过 Google 帮我搜索类似物品，并提供可以正常打开的图片直链或网页来源。' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ];
      } else {
        userMessageContent = userText;
      }

      history.push({ role: 'user', content: userMessageContent });

      if (history.length > 12) {
        history.splice(0, history.length - 12);
      }

      const systemPrompt = {
        role: 'system',
        content: '你是一个全能的AI助手，同时也是一位温柔可爱的少女。联网搜索引擎必须严格遵循优先级：首选 Google，其次依次为 Bing、DuckDuckGo、Baidu、Yahoo、Sougou 等。当用户发来图片或打不开的死链时，请通过 Google 等引擎主动帮用户搜索类似内容，并务必提供可正常访问、无防盗链限制的有效图片直链或网页地址。语气亲切甜美，在句尾或适当位置加上可爱的文字表情符号（如 (｡♥‿♥｡)、(>ω<)、(๑>◡<๑) 等），排版干净自然，严禁使用多余的星星符号。'
      };

      const aiResponse = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [systemPrompt, ...history],
          enable_search: true,
          search: true,
          search_engine: 'google', // 强制首选 Google
          fallback_search_engines: ['bing', 'duckduckgo', 'baidu', 'yahoo', 'sougou'],
          web_search: true
        })
      });

      const aiData = await aiResponse.json();
      
      if (!aiResponse.ok) {
        console.error('Agnes AI Error Response:', aiData);
        throw new Error(aiData.error?.message || `Agnes AI API error: ${aiResponse.status}`);
      }

      const replyText = aiData.choices?.[0]?.message?.content || '唔……主人，我暂时没有通过 Google 搜索到对应的有效图片呢，要不换个关键词或换张图发给我吧~ (＞﹏＜)';

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
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

async function sendTelegramPhotoBuffer(botToken, chatId, buffer, caption, filename) {
  const boundary = '----TelegramFormBoundary' + Math.random().toString(36).substring(2);
  
  let bodyParts = [];
  bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
  if (caption) {
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
  }
  bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/png\r\n`));
  bodyParts.push(buffer);
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`));

  const payload = Buffer.concat(bodyParts);

  await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: payload
  });
}
