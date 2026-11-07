import { replyStyles, validateGenerationSettings } from '../generation-settings.mjs';

const minute = 60_000;
const approvalWindow = 15 * minute;
const activityWindow = 10 * minute;
const jobWindow = 5 * minute;
const idPattern = /^[a-f0-9-]{36}$/;
const modelStates = new Set(['ready', 'sleeping', 'loading', 'stopped', 'error']);

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function json(data, status = 200) {
    return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readBody(request, limit) {
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, '請提供 JSON。');
    const chunks = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw new HttpError(413, '請求內容太長。');
        }
        chunks.push(value);
    }
    return new Blob(chunks).text();
}

async function readJson(request) {
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
        throw new HttpError(415, '請提供 JSON。');
    }
    const raw = await readBody(request, 128 * 1024);
    try {
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
        return payload;
    } catch {
        throw new HttpError(400, 'JSON 格式錯誤。');
    }
}

function requireSameOrigin(request) {
    if (request.headers.get('Origin') !== new URL(request.url).origin) {
        throw new HttpError(403, '請在酒館網站上操作。');
    }
}

function identity(request, env) {
    const owner = request.headers.get('oai-authenticated-user-id');
    const email = request.headers.get('oai-authenticated-user-email')?.toLowerCase();
    const allowed = (env.TAVERN_ALLOWED_EMAILS || '').toLowerCase().split(',').map(value => value.trim());
    if (!owner) throw new HttpError(401, '請先登入。');
    if (!email || !allowed.includes(email)) throw new HttpError(403, '這個帳號沒有模型使用權。');
    return owner;
}

async function tokenMatches(request, env) {
    const token = env.TAVERN_CONNECTOR_TOKEN;
    const header = request.headers.get('Authorization') || '';
    if (!token || token.length < 32 || header.length > 512) return false;
    const encoder = new TextEncoder();
    const [left, right] = await Promise.all([header, `Bearer ${token}`].map(value =>
        crypto.subtle.digest('SHA-256', encoder.encode(value)).then(hash => new Uint8Array(hash))));
    return left.reduce((different, byte, i) => different | (byte ^ right[i]), 0) === 0;
}

async function sendDiscordApproval(env, id) {
    if (!env.DISCORD_BOT_TOKEN || !/^\d{16,22}$/.test(env.DISCORD_APPROVER_ID || '')) {
        throw new HttpError(503, '尚未設定 Discord 私訊。');
    }
    async function discord(path, body) {
        const response = await (env.DISCORD_FETCH || fetch)(`https://discord.com/api/v10${path}`, {
            method: 'POST',
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new HttpError(502, 'Discord 私訊未送達。');
        return response.json();
    }
    const dm = await discord('/users/@me/channels', { recipient_id: env.DISCORD_APPROVER_ID });
    if (!/^\d{16,22}$/.test(dm.id)) throw new HttpError(502, 'Discord 私訊未送達。');
    await discord(`/channels/${dm.id}/messages`, {
        content: '有人在酒館申請使用模型。按 OK 開放這次使用。此請求 15 分鐘後失效。',
        allowed_mentions: { parse: [] },
        components: [{ type: 1, components: [{ type: 2, style: 3, label: 'OK', custom_id: `tavern:approve:${id}` }] }],
        nonce: id.replaceAll('-', '').slice(0, 24),
        enforce_nonce: true,
    });
}

async function verifyDiscord(request, env) {
    const signature = request.headers.get('X-Signature-Ed25519') || '';
    const timestamp = request.headers.get('X-Signature-Timestamp') || '';
    if (!/^[a-f0-9]{128}$/i.test(signature) || !/^\d{10}$/.test(timestamp)
        || !/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY || '')
        || Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * minute) {
        throw new HttpError(401, 'Discord 簽章無效。');
    }
    const toBytes = hex => Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
    const rawBody = await readBody(request, 64 * 1024);
    const key = await crypto.subtle.importKey('raw', toBytes(env.DISCORD_PUBLIC_KEY), 'Ed25519', false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', key, toBytes(signature), new TextEncoder().encode(timestamp + rawBody));
    if (!valid) throw new HttpError(401, 'Discord 簽章無效。');
    return JSON.parse(rawBody);
}

async function discordInteraction(request, env, now) {
    const event = await verifyDiscord(request, env);
    if (event.type === 1) return json({ type: 1 });
    const id = event.data?.custom_id?.match(/^tavern:approve:([a-f0-9-]{36})$/)?.[1];
    if (event.type !== 3 || !id || event.guild_id || event.user?.id !== env.DISCORD_APPROVER_ID) {
        return json({ type: 4, data: { content: '這個請求無法由此帳號批准。', flags: 64 } });
    }
    const [changed] = await env.DB.batch([
        env.DB.prepare(`UPDATE approvals SET state='approved', expires=? WHERE id=? AND state='pending' AND expires>?`)
            .bind(now + approvalWindow, id, now),
        env.DB.prepare(`INSERT INTO jobs (id,owner,approval_id,kind,created,expires)
            SELECT id,owner,id,'prepare',?,? FROM approvals WHERE id=? AND state='approved' AND expires>?
            ON CONFLICT(id) DO NOTHING`).bind(now, now + approvalWindow, id, now),
    ]);
    return json({ type: 7, data: { content: changed.meta.changes
        ? '已批准。酒館會在 Mac 連線後準備模型。' : '這則請求已處理或失效。', components: [] } });
}

async function cleanExpired(db, now) {
    await db.batch([
        db.prepare(`UPDATE jobs SET state='failed',input='{}',error='等待模型逾時，請重新送出。'
            WHERE state IN ('queued','running') AND expires<=?`).bind(now),
        db.prepare(`UPDATE approvals SET state='expired' WHERE state IN ('pending','approved','ready') AND expires<=?`).bind(now),
    ]);
}

async function connector(request, env, path, now) {
    if (!(await tokenMatches(request, env))) throw new HttpError(403, '連接器未配對。');
    const body = await readJson(request);
    if (path === '/api/connector/poll') {
        if (!modelStates.has(body.state)) throw new HttpError(400, '模型狀態無效。');
        await cleanExpired(env.DB, now);
        await env.DB.prepare(`INSERT INTO model_status (id,state,seen) VALUES (1,?,?)
            ON CONFLICT(id) DO UPDATE SET state=excluded.state,seen=excluded.seen`).bind(body.state, now).run();
        const lease = crypto.randomUUID();
        const job = await env.DB.prepare(`UPDATE jobs SET state='running',lease=?
            WHERE id=(SELECT j.id FROM jobs j JOIN approvals a ON a.id=j.approval_id
                WHERE j.state='queued' AND j.expires>? AND a.expires>?
                AND ((j.kind='prepare' AND a.state='approved') OR (j.kind='chat' AND a.state='ready'))
                ORDER BY j.created LIMIT 1)
            AND state='queued' RETURNING id,kind,input,expires`).bind(lease, now, now).first();
        const input = job && JSON.parse(job.input);
        return json({ job: job ? { id: job.id, kind: job.kind, expires: job.expires,
            input: { messages: input.messages, parameters: input.parameters }, lease, model: env.TAVERN_MODEL_ID || 'f451-writer' } : null });
    }
    if (path !== '/api/connector/result') throw new HttpError(404, '找不到端點。');
    const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id=? AND lease=? AND state='running' AND expires>?`)
        .bind(body.id || '', body.lease || '', now).first();
    if (!job) return json({ accepted: false });
    const statements = [];
    const ok = body.ok === true && (job.kind === 'prepare' || (typeof body.text === 'string' && body.text.trim() && body.text.length <= 32_000));
    const failure = '模型沒有完成請求。請確認 Mac、模型服務與外接磁碟。';
    if (job.kind === 'prepare') {
        statements.push(env.DB.prepare(`UPDATE approvals SET state=?,expires=? WHERE id=? AND state='approved'
            AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease=? AND state='running' AND expires>?)`)
            .bind(ok ? 'ready' : 'failed', now + activityWindow, job.approval_id, job.id, job.lease, now));
    } else if (ok) {
        const input = JSON.parse(job.input);
        const reply = { role: 'assistant', content: body.text };
        statements.push(env.DB.prepare(`UPDATE chats SET title=?,messages=?,updated=? WHERE id=? AND owner=?
            AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease=? AND state='running' AND expires>?)`)
            .bind(input.title, JSON.stringify([...input.history, reply]), now, job.chat_id, job.owner, job.id, job.lease, now));
        statements.push(env.DB.prepare(`UPDATE approvals SET expires=? WHERE id=? AND state='ready' AND expires>?
            AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease=? AND state='running' AND expires>?)`)
            .bind(now + activityWindow, job.approval_id, now, job.id, job.lease, now));
    }
    statements.push(env.DB.prepare(`UPDATE jobs SET state=?,input='{}',error=?
        WHERE id=? AND lease=? AND state='running' AND expires>?`).bind(ok ? 'done' : 'failed', ok ? null : failure, job.id, job.lease, now));
    const results = await env.DB.batch(statements);
    return json({ accepted: !!results.at(-1).meta.changes });
}

async function latestApproval(db, owner, now) {
    const row = await db.prepare('SELECT id,state,expires FROM approvals WHERE owner=? ORDER BY created DESC LIMIT 1').bind(owner).first();
    if (row && row.expires <= now && ['pending', 'approved', 'ready'].includes(row.state)) row.state = 'expired';
    return row;
}

async function requestAccess(env, owner, now) {
    const id = crypto.randomUUID();
    const db = env.DB;
    const inserted = await db.prepare(`INSERT INTO approvals (id,owner,state,created,expires)
        SELECT ?,?,'pending',?,? WHERE NOT EXISTS
        (SELECT 1 FROM approvals WHERE owner=? AND ((state IN ('pending','approved','ready') AND expires>?) OR created>?))`)
        .bind(id, owner, now, now + approvalWindow, owner, now, now - minute).run();
    if (!inserted.meta.changes) return json({ approval: await latestApproval(db, owner, now) });
    try {
        await sendDiscordApproval(env, id);
    } catch {
        await db.prepare(`UPDATE approvals SET state='failed' WHERE id=? AND state='pending'`).bind(id).run();
        throw new HttpError(502, '無法送出 Discord 私訊。請稍後再試。');
    }
    return json({ approval: { id, state: 'pending', expires: now + approvalWindow } }, 201);
}

async function chatRoute(request, env, path, owner, now) {
    const db = env.DB;
    if (path === '/api/tavern/chats') {
        if (request.method === 'GET') {
            const { results } = await db.prepare('SELECT id,title FROM chats WHERE owner=? ORDER BY updated DESC LIMIT 200').bind(owner).all();
            return json({ chats: results });
        }
        const id = crypto.randomUUID();
        await db.prepare('INSERT INTO chats (id,owner,title,updated) VALUES (?,?,?,?)').bind(id, owner, '新聊天', now).run();
        return json({ id, title: '新聊天', messages: [] }, 201);
    }
    const id = path.split('/').at(-1);
    if (!idPattern.test(id)) throw new HttpError(404, '找不到聊天室。');
    const chat = await db.prepare('SELECT id,title,messages FROM chats WHERE id=? AND owner=?').bind(id, owner).first();
    if (!chat) throw new HttpError(404, '找不到聊天室。');
    const messages = JSON.parse(chat.messages);
    if (request.method === 'GET') {
        const job = await db.prepare(`SELECT id,state,error,expires FROM jobs WHERE chat_id=? AND owner=? ORDER BY created DESC LIMIT 1`).bind(id, owner).first();
        if (job && job.expires <= now && ['queued','running'].includes(job.state)) {
            job.state = 'failed';
            job.error = '等待模型逾時，請重新送出。';
        }
        return json({ ...chat, messages, job });
    }
    const body = await readJson(request);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000) {
        throw new HttpError(400, '請輸入 1 到 8,000 字的訊息。');
    }
    await cleanExpired(db, now);
    const approval = await latestApproval(db, owner, now);
    if (approval?.state !== 'ready') throw new HttpError(409, '請先在模型選單送出使用請求。');
    let settings;
    try {
        settings = validateGenerationSettings(body.generation);
    } catch (error) {
        throw new HttpError(400, error.message);
    }
    if (messages.length >= 200) throw new HttpError(409, '這個聊天室已達訊息上限，請新增聊天。');
    const history = [...messages, { role: 'user', content: body.text.trim() }];
    if (new TextEncoder().encode(JSON.stringify(history)).length > 512 * 1024) {
        throw new HttpError(409, '這個聊天室已達容量上限，請新增聊天。');
    }
    const title = messages.length ? chat.title : body.text.trim().slice(0, 28);
    const system = replyStyles[settings.style].instruction;
    const prompt = history.slice(-12);
    if (system) prompt.unshift({ role: 'system', content: system });
    const job = crypto.randomUUID();
    const [queued] = await db.batch([
        db.prepare(`INSERT INTO jobs (id,owner,approval_id,chat_id,kind,input,created,expires)
            SELECT ?,owner,id,?,'chat',?,?,? FROM approvals WHERE id=? AND owner=? AND state='ready' AND expires>?
            AND EXISTS (SELECT 1 FROM chats WHERE id=? AND owner=? AND messages=?)
            ON CONFLICT DO NOTHING`)
            .bind(job, id, JSON.stringify({ title, history, messages: prompt, parameters: settings.parameters }), now,
                now + jobWindow, approval.id, owner, now, id, owner, chat.messages),
        db.prepare(`UPDATE approvals SET expires=MAX(expires,?) WHERE id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=?)`)
            .bind(now + activityWindow, approval.id, job),
    ]);
    if (!queued.meta.changes) throw new HttpError(409, '聊天室有進行中的請求或內容已更新。請稍後再試。');
    return json({ job }, 202);
}

export async function handleTavernApi(request, env) {
    const path = new URL(request.url).pathname;
    if (!/^\/api\/(tavern(?:\/|$)|connector\/|discord\/interactions$)/.test(path)) return null;
    const now = Date.now();
    try {
        if (request.method === 'GET' && path === '/api/tavern/account') {
            const signedIn = request.headers.has('oai-authenticated-user-id');
            return json({ email: signedIn ? request.headers.get('oai-authenticated-user-email') : null });
        }
        if (!env.DB) throw new HttpError(503, '網站的模型服務尚未設定。');
        if (request.method === 'POST' && path === '/api/discord/interactions') return await discordInteraction(request, env, now);
        if (request.method === 'POST' && path.startsWith('/api/connector/')) return await connector(request, env, path, now);
        const owner = identity(request, env);
        if (request.method === 'POST') requireSameOrigin(request);
        if (request.method === 'GET' && path === '/api/tavern/status') {
            const model = await env.DB.prepare('SELECT state,seen FROM model_status WHERE id=1').first();
            return json({ model: env.TAVERN_MODEL_ID || 'f451-writer',
                state: model && now - model.seen < 30_000 ? model.state : 'offline',
                approval: await latestApproval(env.DB, owner, now) });
        }
        if (request.method === 'POST' && path === '/api/tavern/request') return await requestAccess(env, owner, now);
        if (['GET', 'POST'].includes(request.method) && /^\/api\/tavern\/chats(?:\/[^/]+)?$/.test(path)) {
            return await chatRoute(request, env, path, owner, now);
        }
        throw new HttpError(404, '找不到端點。');
    } catch (error) {
        return json({ error: error instanceof HttpError ? error.message : '酒館暫時無法處理請求。' },
            error instanceof HttpError ? error.status : 500);
    }
}
