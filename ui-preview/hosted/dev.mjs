import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createLocalDb } from './sqlite.mjs';
import { createConnector } from './connector.mjs';
import worker from './worker.mjs';
import { rewriteDirective } from '../generation-settings.mjs';
import { summaryInstruction } from './memory.mjs';

const port = Number(process.env.TAVERN_DEV_PORT || 8121);
const origin = `http://127.0.0.1:${port}`;
const browserAccounts = ['alice', 'bob'];
let modelStarted = false;
const token = crypto.randomUUID();
const env = {
    DB: createLocalDb(process.env.TAVERN_DEV_DB),
    TAVERN_ALLOWED_EMAILS: 'alice@example.test,bob@example.test',
    TAVERN_APPROVER_EMAIL: 'bob@example.test',
    TAVERN_CONNECTOR_TOKEN: token,
    ASSETS: { fetch: assetResponse },
};

const assets = new Map([
    ['/', ['../index.html', 'text/html; charset=utf-8']],
    ['/app.css', ['../app.css', 'text/css']],
    ['/app.js', ['../app.js', 'text/javascript']],
    ['/generation-settings.mjs', ['../generation-settings.mjs', 'text/javascript']],
    ['/hosted/ui.mjs', ['./ui.mjs', 'text/javascript']],
    ['/public/css/fontawesome.min.css', ['../../public/css/fontawesome.min.css', 'text/css']],
    ['/public/css/solid.min.css', ['../../public/css/solid.min.css', 'text/css']],
    ['/public/webfonts/fa-solid-900.woff2', ['../../public/webfonts/fa-solid-900.woff2', 'font/woff2']],
    ['/public/webfonts/NotoSans/stylesheet.css', ['../../public/webfonts/NotoSans/stylesheet.css', 'text/css']],
]);

async function assetResponse(request) {
    const path = new URL(request.url).pathname;
    const font = /^\/public\/webfonts\/NotoSans\/(NotoSans-[A-Za-z]+\.(woff2?))$/.exec(path);
    const file = assets.get(path) ?? (font && [`../..${path}`, `font/${font[2]}`]);
    if (!file) return new Response('找不到頁面', { status: 404 });
    let bytes = await readFile(new URL(file[0], import.meta.url));
    if (path === '/') {
        bytes = bytes.toString('utf8').replace('<body>', '<body data-test-mode>');
    }
    return new Response(bytes, { headers: { 'Content-Type': file[1], 'Cache-Control': 'no-store' } });
}

async function devRoute(request) {
    const path = new URL(request.url).pathname;
    if (path === '/_test/signin' && request.method === 'GET') {
        return new Response(`<!doctype html><meta charset="utf-8"><title>酒館測試登入</title>
            <h1>酒館測試登入</h1><p>這是只在本機提供的假帳號。</p>
            <form method="post" action="/_test/session">
            <button name="account" value="alice">登入測試帳號 Alice</button>
            <button name="account" value="bob">登入測試帳號 Bob</button>
            </form>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (request.method !== 'POST' || request.headers.get('Origin') !== origin) {
        return new Response('Forbidden', { status: 403 });
    }
    if (path === '/_test/session') {
        const value = (await request.formData()).get('account');
        if (browserAccounts.includes(value)) {
            return new Response(null, { status: 303, headers: {
                Location: '/', 'Set-Cookie': `tavern_test=${value}; HttpOnly; SameSite=Strict; Path=/`,
            } });
        }
    }
    return new Response('Not found', { status: 404 });
}

const server = createServer(async (incoming, outgoing) => {
    try {
        if (incoming.headers.host !== `127.0.0.1:${port}`) {
            outgoing.writeHead(403).end();
            return;
        }
        const headers = new Headers(incoming.headers);
        headers.delete('oai-authenticated-user-id');
        headers.delete('oai-authenticated-user-email');
        const match = headers.get('cookie')?.match(/(?:^|;\s*)tavern_test=(alice|bob)(?:;|$)/);
        if (match) {
            headers.set('oai-authenticated-user-id', match[1]);
            headers.set('oai-authenticated-user-email', `${match[1]}@example.test`);
        }
        const request = new Request(new URL(incoming.url, origin), {
            method: incoming.method, headers,
            ...(!['GET', 'HEAD'].includes(incoming.method) && { body: incoming, duplex: 'half' }),
        });
        const response = request.url.startsWith(`${origin}/_test/`)
            ? await devRoute(request) : await worker.fetch(request, env);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
        outgoing.writeHead(500).end();
    }
});

const connector = createConnector({ site: origin, model: 'f451-writer',
    modelUrl: 'http://127.0.0.1:8787', token, startScript: 'simulated' }, {
    launch: async () => { modelStarted = true; },
    fetcher: async (url, options) => {
        const target = new URL(url);
        if (target.origin === origin) return fetch(url, options);
        if (!modelStarted) throw new Error('offline', { cause: { code: 'ECONNREFUSED' } });
        if (target.pathname === '/health') return Response.json({ status: 'ok' });
        if (target.pathname === '/props') return Response.json({ is_sleeping: false, default_generation_settings: { n_ctx: 4096 } });
        if (target.pathname === '/v1/models') return Response.json({ data: [{ id: 'f451-writer' }] });
        if (target.pathname === '/apply-template') return Response.json({ prompt: options.body });
        if (target.pathname === '/tokenize') {
            return Response.json({ tokens: Array(Math.ceil(JSON.parse(options.body).content.length / 3)).fill(0) });
        }
        const { messages } = JSON.parse(options.body);
        const input = messages.at(-1).content;
        let content = `假模型回覆：${input}`;
        if (messages[0]?.content === summaryInstruction) content = '模擬模型已整理較早的對話。';
        if (messages[0]?.role === 'system' && messages[0].content.endsWith(rewriteDirective)) {
            try {
                const { selected } = JSON.parse(input);
                if (typeof selected === 'string') content = `【模擬改寫】${selected}`;
            } catch {
                // A custom system prompt can also include the rewrite instruction.
            }
        }
        return Response.json({ choices: [{ message: { content } }] });
    },
});

server.listen(port, '127.0.0.1', () => {
    console.log(`酒館整合測試：${origin}/`);
    let busy = false;
    setInterval(async () => {
        if (busy) return;
        busy = true;
        try { await connector.step(); } catch (error) { console.error(error.message); }
        finally { busy = false; }
    }, 750).unref();
});
