import { access, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { ContextFull, prepareChat } from './memory.mjs';

const states = new Set(['ready', 'sleeping', 'loading', 'stopped', 'error']);

export function validateConnectorConfig(settings, { allowHttpLoopback = false } = {}) {
    const site = URL.parse(settings.site || '');
    const modelUrl = URL.parse(settings.modelUrl || 'http://127.0.0.1:8787');
    if (!site || site.href !== `${site.origin}/` || site.username || site.password
        || (site.protocol !== 'https:' && !(allowHttpLoopback && site.protocol === 'http:' && site.hostname === '127.0.0.1'))) {
        throw new Error('site 請填網站的 HTTPS 網址。');
    }
    if (!modelUrl || modelUrl.href !== `${modelUrl.origin}/` || modelUrl.username || modelUrl.password
        || modelUrl.protocol !== 'http:' || modelUrl.hostname !== '127.0.0.1') {
        throw new Error('modelUrl 必須是 Mac 本機的 127.0.0.1 網址。');
    }
    if (typeof settings.token !== 'string' || settings.token.length < 32 || settings.token.length > 256) {
        throw new Error('請填配對後取得的連接器金鑰。');
    }
    if (typeof settings.model !== 'string' || !settings.model.trim()) throw new Error('請填模型 ID。');
    if (settings.summarizeHistory !== undefined && typeof settings.summarizeHistory !== 'boolean') {
        throw new Error('summarizeHistory 請填 true 或 false。');
    }
    for (const name of ['startScript', 'modelFile']) {
        if (settings[name] && (typeof settings[name] !== 'string' || !isAbsolute(settings[name]))) {
            throw new Error(`${name} 必須是本機絕對路徑。`);
        }
    }
    return { ...settings, site: site.origin, modelUrl: modelUrl.origin };
}

export function createConnector(config, { fetcher = fetch, launch = launchScript, pause = wait } = {}) {
    async function site(path, body) {
        const response = await fetcher(`${config.site}/api/connector/${path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
            redirect: 'error',
        });
        if (!response.ok) throw new Error(`網站配對或連線失敗（HTTP ${response.status}）。`);
        return response.json();
    }

    let contextSize = 4096;
    async function probe() {
        try {
            const health = await fetcher(`${config.modelUrl}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
            if (health.status === 503) return 'loading';
            if (!health.ok) return 'error';
            const props = await fetcher(`${config.modelUrl}/props`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
            if (!props.ok) return 'error';
            const properties = await props.json();
            const size = properties.default_generation_settings?.n_ctx;
            contextSize = Number.isSafeInteger(size) && size >= 256 ? size : 4096;
            return properties.is_sleeping === true ? 'sleeping' : 'ready';
        } catch (error) {
            return error.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'error';
        }
    }

    async function modelPost(path, body, timeout, deadline) {
        const response = await fetcher(`${config.modelUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))),
            redirect: 'error',
        });
        if (!response.ok) throw new Error(`本機模型回傳 HTTP ${response.status}。`);
        return response.json();
    }

    async function ensureModel(deadline) {
        const state = await probe();
        if (state === 'stopped') {
            if (!config.startScript) throw new Error('模型服務已停止，尚未設定本機啟動腳本。');
            if (config.modelFile) await access(config.modelFile);
            await launch(config.startScript);
        }
        const until = Math.min(deadline, Date.now() + 120_000);
        while (Date.now() < until) {
            const current = await probe();
            if (current === 'ready' || current === 'sleeping') {
                const models = await fetcher(`${config.modelUrl}/v1/models`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
                const entries = models.ok && (await models.json()).data;
                if (!Array.isArray(entries) || !entries.some(model => model.id === config.model)) {
                    throw new Error('本機模型 ID 與配對設定不符。');
                }
                return;
            }
            if (current === 'error') throw new Error('模型健康檢查失敗。');
            await pause(1500);
        }
        throw new Error('模型服務啟動逾時。');
    }

    let pendingResult;
    let jobExpires;
    async function step() {
        if (pendingResult && Date.now() < jobExpires) {
            await site('result', pendingResult);
            pendingResult = undefined;
            return;
        }
        pendingResult = undefined;
        const state = await probe();
        const { job } = await site('poll', { state, memory: true });
        if (!job) return;
        if (typeof job.id !== 'string' || typeof job.lease !== 'string' || !Number.isFinite(job.expires)) {
            throw new Error('網站傳回的工作格式錯誤。');
        }
        if (Date.now() >= job.expires) return;
        jobExpires = job.expires;
        try {
            if (job.model !== config.model || !['prepare', 'chat'].includes(job.kind)) {
                throw new Error('拒絕處理未配對的模型或工作類型。');
            }
            if (job.kind === 'prepare') {
                await ensureModel(job.expires);
                pendingResult = { id: job.id, lease: job.lease, ok: true };
            } else {
                if (!['ready', 'sleeping'].includes(state)) throw new Error('模型不在線，請重新送出使用請求。');
                const { messages, parameters, context } = job.input || {};
                if (!Array.isArray(messages)) throw new Error('聊天工作沒有可用訊息。');
                const allowed = ['temperature', 'top_p', 'max_tokens', 'frequency_penalty', 'presence_penalty'];
                const fields = Object.fromEntries(allowed.filter(key => Number.isFinite(parameters?.[key]))
                    .map(key => [key, parameters[key]]));
                const complete = async (prompt, generation, timeout) => {
                    const response = await modelPost('/v1/chat/completions',
                        { ...generation, messages: prompt, model: config.model, stream: false }, timeout, job.expires);
                    const reply = response.choices?.[0]?.message?.content;
                    if (typeof reply !== 'string' || !reply.trim()) throw new Error('模型未回傳文字。');
                    return reply;
                };
                let canTokenize = true;
                const count = async prompt => {
                    if (canTokenize) {
                        try {
                            const { prompt: rendered } = await modelPost('/apply-template', { messages: prompt }, 4000, job.expires);
                            if (typeof rendered !== 'string') throw new Error();
                            const { tokens } = await modelPost('/tokenize',
                                { content: rendered, add_special: true, parse_special: true }, 4000, job.expires);
                            if (!Array.isArray(tokens)) throw new Error();
                            return tokens.length;
                        } catch {
                            canTokenize = false;
                        }
                    }
                    return prompt.reduce((sum, message) => sum + Buffer.byteLength(message.content) + 20, 0);
                };
                const fitted = await prepareChat({ messages, context }, {
                    contextSize, maxReply: fields.max_tokens, count, complete,
                    summarizeHistory: config.summarizeHistory !== false && job.expires - Date.now() > 60_000,
                });
                const reply = await complete(fitted.prompt, { ...fields, max_tokens: fitted.maxReply }, 180_000);
                pendingResult = { id: job.id, lease: job.lease, ok: true, text: reply, memory: fitted.memory };
            }
        } catch (error) {
            console.error(error.message);
            pendingResult = { id: job.id, lease: job.lease, ok: false, contextFull: error instanceof ContextFull };
        }
        await site('result', pendingResult);
        pendingResult = undefined;
    }
    return { step, probe };
}

async function launchScript(script) {
    if (process.platform !== 'darwin') throw new Error('本機腳本只在 macOS 執行。');
    await access(script);
    await new Promise((resolve, reject) => {
        const processHandle = spawn('/bin/zsh', [script], { detached: true, stdio: 'ignore' });
        processHandle.once('error', reject);
        processHandle.once('spawn', () => {
            processHandle.unref();
            resolve();
        });
    });
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
    try {
        const filename = process.argv[2] || 'connector.local.json';
        const config = validateConnectorConfig(JSON.parse(await readFile(filename, 'utf8')));
        const connector = createConnector(config);
        if (process.argv.includes('--check')) {
            const status = await connector.probe();
            console.log(`本機模型：${states.has(status) ? status : 'error'}`);
        } else {
            console.log('酒館連接器已啟動，等待網站的批准工作。');
            let delay = 5000;
            for (;;) {
                try {
                    await connector.step();
                    delay = 5000;
                } catch (error) {
                    console.error(error.message);
                    delay = Math.min(delay * 2, 30_000);
                }
                await wait(delay);
            }
        }
    } catch (error) {
        console.error(error instanceof SyntaxError ? '設定檔不是有效的 JSON。' : error.message);
        process.exitCode = 1;
    }
}
