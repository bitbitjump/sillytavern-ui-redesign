import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chatSystemMessage, prepareRewrite, rewriteDirective, validateGenerationSettings } from './generation-settings.mjs';

const host = '127.0.0.1';
const port = Number(process.env.TAVERN_PORT || 8120);
const modelId = process.env.TAVERN_MODEL_ID?.trim();
const modelToken = process.env.TAVERN_MODEL_TOKEN;
const configuredUrl = process.env.TAVERN_MODEL_URL?.trim();
const baseUrl = configuredUrl ? URL.parse(configuredUrl) : null;
const webhookSetting = process.env.TAVERN_DISCORD_WEBHOOK_URL?.trim();
const discordWebhook = webhookSetting ? URL.parse(webhookSetting) : null;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('TAVERN_PORT 必須是 1 到 65535 之間的連接埠。');
}
if (configuredUrl && (!baseUrl || !['http:', 'https:'].includes(baseUrl.protocol)
  || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !modelId)) {
  throw new Error('請設定有效的模型 Base URL 與模型 ID。憑證請另外設定。');
}
if (baseUrl && baseUrl.protocol === 'http:' && modelToken
  && !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)
  && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(baseUrl.hostname)) {
  throw new Error('帶金鑰的遠端連線請使用 HTTPS 或 Tailscale 的 100.x IP。');
}
if (webhookSetting && (!discordWebhook || discordWebhook.origin !== 'https://discord.com'
  || discordWebhook.username || discordWebhook.password || discordWebhook.search || discordWebhook.hash
  || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(discordWebhook.pathname))) {
  throw new Error('請填寫 Discord 提供的完整 HTTPS Webhook 網址。');
}

const origin = `http://${host}:${port}`;
const resources = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/generation-settings.mjs', ['generation-settings.mjs', 'text/javascript; charset=utf-8']],
  ['/public/css/fontawesome.min.css', ['../public/css/fontawesome.min.css', 'text/css; charset=utf-8']],
  ['/public/css/solid.min.css', ['../public/css/solid.min.css', 'text/css; charset=utf-8']],
  ['/public/webfonts/fa-solid-900.woff2', ['../public/webfonts/fa-solid-900.woff2', 'font/woff2']],
  ['/public/webfonts/fa-solid-900.ttf', ['../public/webfonts/fa-solid-900.ttf', 'font/ttf']],
]);
const fontTypes = { woff: 'font/woff', woff2: 'font/woff2' };
const maxBody = 128 * 1024;
const connectionErrors = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']);
let notifiedForOutage = false;
let nextNotificationAttempt = 0;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ModelUnreachableError extends ApiError {
  constructor() {
    super(502, '無法連到模型 API。請檢查端點、Tailscale 和朋友端服務。');
  }
}

async function notifyModelUnavailable() {
  if (!discordWebhook || notifiedForOutage || Date.now() < nextNotificationAttempt) return '';
  nextNotificationAttempt = Date.now() + 30 * 60_000;
  try {
    const response = await fetch(discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '有人想使用酒館模型，但目前連不上服務。有空時請確認模型服務與 Tailscale 是否在線。',
        allowed_mentions: { parse: [] },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    await response.body?.cancel();
    if (!response.ok) return 'Discord 通知未送達。';
    notifiedForOutage = true;
    return '已送出 Discord 通知。';
  } catch {
    return 'Discord 通知未送達。';
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readChatRequest(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) {
      request.resume();
      throw new ApiError(413, '對話太長，請開一個新聊天再試。');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, '訊息格式錯誤。');
  }
  if (!Array.isArray(body?.messages) || !body.messages.length || body.messages.length > 100
    || !body.messages.every(message => ['user', 'assistant'].includes(message?.role)
      && typeof message?.content === 'string' && message.content.trim())
    || body.messages.at(-1).role !== 'user') {
    throw new ApiError(400, '對話格式錯誤或超過 100 則訊息。');
  }
  let settings;
  let instruction;
  let rewrite;
  try {
    settings = validateGenerationSettings(body.generation);
    instruction = chatSystemMessage(settings.style, body.context);
    if (body.rewrite !== undefined) rewrite = prepareRewrite(body.rewrite?.source, body.rewrite);
  } catch (error) {
    throw new ApiError(400, error.message);
  }
  const messages = body.messages.map(({ role, content }) => ({ role, content }));
  if (rewrite) {
    return {
      messages: [
        { role: 'system', content: [instruction, rewriteDirective].filter(Boolean).join('\n\n') },
        { role: 'user', content: rewrite.prompt },
      ],
      parameters: settings.parameters,
      rewrite,
    };
  }
  if (instruction) messages.unshift({ role: 'system', content: instruction });
  return { messages, parameters: settings.parameters };
}

async function modelRequest(path, body) {
  const target = new URL(baseUrl);
  target.pathname = target.pathname.replace(/\/$/, '') + path;
  let response;
  try {
    response = await fetch(target, {
      method: body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }),
        ...(modelToken && { Authorization: `Bearer ${modelToken}` }),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(body ? 120_000 : 8_000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new ApiError(504, '模型服務回應逾時，可能正在啟動或忙碌。');
    }
    if (connectionErrors.has(error.cause?.code)) throw new ModelUnreachableError();
    throw new ApiError(502, '無法取得模型 API 回應，請確認端點、連線或 TLS 設定。');
  }
  notifiedForOutage = false;
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) {
      throw new ApiError(response.status, '模型 API 拒絕存取，請確認金鑰或存取權限。');
    }
    if (response.status === 404) {
      throw new ApiError(404, '找不到模型 API 路徑或模型 ID，請確認 Base URL 與模型設定。');
    }
    throw new ApiError(502, `模型 API 回傳 HTTP ${response.status}。`);
  }
  try {
    return await response.json();
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new ApiError(504, '模型回應讀取逾時。');
    }
    throw new ApiError(502, '端點未回傳 JSON。請確認填的是模型 API 網址。');
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.headers.host !== `${host}:${port}`) {
    return json(response, 403, { error: '請由本機啟動網址開啟酒館。' });
  }
  const path = new URL(request.url, origin).pathname;
  try {
    if (request.method === 'GET' && path === '/api/local-model') {
      return json(response, 200, { mode: baseUrl ? 'remote' : 'mock', model: baseUrl ? modelId : '測試模型' });
    }
    if (request.method === 'POST') {
      if (request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/json')) {
        throw new ApiError(403, '請從本機酒館介面送出請求。');
      }
      if (path === '/api/local-model/check') {
        if (baseUrl) {
          const result = await modelRequest('/models');
          if (!Array.isArray(result?.data)) {
            throw new ApiError(502, '模型清單格式不符，請確認端點支援 OpenAI 相容 API。');
          }
          if (!result.data.some(model => model?.id === modelId)) {
            throw new ApiError(404, '端點已連通，但模型清單裡沒有設定的模型 ID。');
          }
        }
        return json(response, 200, { status: baseUrl ? '端點已連通，模型 ID 已確認。' : '測試模式正常，尚未連接外部模型。' });
      }
      if (path === '/api/local-model/chat') {
        const { messages, parameters, rewrite } = await readChatRequest(request);
        if (!baseUrl) {
          if (rewrite) {
            const replacement = `【模擬改寫】${JSON.parse(rewrite.prompt).selected}`;
            return json(response, 200, { content: rewrite.before + replacement + rewrite.after });
          }
          return json(response, 200, { content: `測試模式（非模型生成）\n已收到：${messages.at(-1).content}` });
        }
        const result = await modelRequest('/chat/completions', { model: modelId, messages, stream: false, ...parameters });
        const content = result?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new ApiError(502, '模型沒有回傳可顯示的文字。');
        }
        return json(response, 200, { content: rewrite ? rewrite.before + content + rewrite.after : content });
      }
    }
    if (request.method === 'GET') {
      const font = /^\/public\/webfonts\/NotoSans\/(stylesheet\.css|NotoSans-[A-Za-z]+\.(woff2?))$/.exec(path);
      const resource = resources.get(path) ?? (font && [`..${path}`, fontTypes[font[2]] ?? 'text/css; charset=utf-8']);
      if (resource) {
        const [file, type] = resource;
        const data = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, { 'Content-Type': type });
        return response.end(data);
      }
    }
    return json(response, 404, { error: '找不到這個頁面。' });
  } catch (error) {
    const notice = error instanceof ModelUnreachableError && path === '/api/local-model/chat'
      ? await notifyModelUnavailable() : '';
    return json(response, error instanceof ApiError ? error.status : 500, {
      error: error instanceof ApiError ? [error.message, notice].filter(Boolean).join(' ') : '本機酒館發生錯誤。',
    });
  }
});

server.listen(port, host, () => console.log(`酒館本機版：${origin}（${baseUrl ? '模型連線模式' : '測試模式'}）`));
