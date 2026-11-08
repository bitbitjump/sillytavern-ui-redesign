import assert from 'node:assert/strict';
import { handleTavernApi } from './api.mjs';
import { createConnector, validateConnectorConfig } from './connector.mjs';
import { createLocalDb } from './sqlite.mjs';

const site = 'https://tavern.example.test';
const modelUrl = 'http://127.0.0.1:8787';
const model = 'f451-writer';
const token = crypto.randomUUID();
const approver = '111111111111111111';
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const hex = buffer => Buffer.from(buffer).toString('hex');
const db = createLocalDb();
const notifications = [];
const env = {
    DB: db,
    TAVERN_ALLOWED_EMAILS: 'alice@example.test,bob@example.test',
    TAVERN_CONNECTOR_TOKEN: token,
    DISCORD_APPROVER_ID: approver,
    DISCORD_PUBLIC_KEY: hex(await crypto.subtle.exportKey('raw', keys.publicKey)),
    DISCORD_BOT_TOKEN: 'mock',
    DISCORD_FETCH: async (url, options) => {
        if (url.endsWith('/users/@me/channels')) return Response.json({ id: '222222222222222222' });
        notifications.push(JSON.parse(options.body));
        return Response.json({ id: '333333333333333333' });
    },
};

async function call(path, { user, body, headers = {}, origin = site } = {}) {
    return handleTavernApi(new Request(site + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json',
            ...(user && { 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': `${user}@example.test` }),
            ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
}

async function approve(customId, actor = approver) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { type: 3, user: { id: actor }, data: { custom_id: customId } };
    const signed = await crypto.subtle.sign('Ed25519', keys.privateKey,
        new TextEncoder().encode(timestamp + JSON.stringify(body)));
    return call('/api/discord/interactions', { body, headers: {
        'X-Signature-Ed25519': hex(signed), 'X-Signature-Timestamp': timestamp,
    } });
}

let running = false;
let sleeping = false;
let starts = 0;
let upstreamRequest;
let upstreamReply = 'model answer';
const config = validateConnectorConfig({ site, modelUrl, model, token, startScript: process.cwd() });
const mac = createConnector(config, {
    launch: async () => { starts++; running = true; },
    pause: async () => {},
    fetcher: async (url, options) => {
        if (url.startsWith(site)) return handleTavernApi(new Request(url, options), env);
        assert.ok(url.startsWith(modelUrl));
        if (!running) throw new Error('stopped', { cause: { code: 'ECONNREFUSED' } });
        if (url.endsWith('/health')) return Response.json({ status: 'ok' });
        if (url.endsWith('/props')) return Response.json({ is_sleeping: sleeping });
        if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: model }] });
        assert.ok(url.endsWith('/v1/chat/completions'));
        sleeping = false;
        upstreamRequest = JSON.parse(options.body);
        return Response.json({ choices: [{ message: { content: upstreamReply } }] });
    },
});

try {
    assert.deepEqual(await (await call('/api/tavern/account')).json(), { email: null });
    const aliceAccount = await call('/api/tavern/account', { user: 'alice' });
    assert.equal(aliceAccount.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await aliceAccount.json(), { email: 'alice@example.test' });
    assert.deepEqual(await (await call('/api/tavern/account', { user: 'bob' })).json(), { email: 'bob@example.test' });
    const appearance = { mode: 'custom', color: '#5777dd' };
    const accountPath = '/api/tavern/account';
    assert.equal((await call(accountPath, { body: { displayName: '訪客', avatar: null } })).status, 401);
    assert.equal((await call(accountPath, { user: 'alice', origin: 'https://other.test', body: { appearance } })).status, 403);
    assert.equal((await call(accountPath, { user: 'alice', body: { displayName: 'Alice', avatar: 'data:image/svg+xml;base64,AAAA' } })).status, 400);
    assert.equal((await call(accountPath, { user: 'alice', body: { appearance: { mode: 'custom', color: 'red' } } })).status, 400);
    assert.equal((await call(accountPath, { user: 'alice', body: { displayName: ' 夜雨 ', avatar: null } })).status, 200);
    const alicePreferences = { email: 'alice@example.test', displayName: '夜雨', avatar: null, appearance };
    assert.deepEqual(await (await call(accountPath, { user: 'alice', body: { appearance } })).json(), alicePreferences);
    assert.deepEqual(await (await call(accountPath, { user: 'alice', body: { displayName: 'Alice', avatar: null } })).json(), {
        ...alicePreferences, displayName: 'Alice',
    });
    assert.deepEqual(await (await call(accountPath, { user: 'bob' })).json(), { email: 'bob@example.test' });
    assert.equal((await call('/api/tavern/chats')).status, 401);
    assert.equal((await call('/api/tavern/chats', { user: 'outsider' })).status, 403);
    assert.equal((await call('/api/tavern/request', { user: 'alice', body: {}, origin: 'https://other.test' })).status, 403);
    assert.equal((await call('/api/connector/poll', { body: { state: 'ready' } })).status, 403);
    const alice = { user: 'alice' };
    const bob = { user: 'bob' };
    const chat = await (await call('/api/tavern/chats', { ...alice, body: {} })).json();
    const chatPath = `/api/tavern/chats/${chat.id}`;
    assert.equal((await call(chatPath, { ...alice, body: { text: 'before approval' } })).status, 409);
    assert.equal((await call(chatPath, bob)).status, 404);
    assert.equal((await call(chatPath, { ...bob, body: { text: 'try other account' } })).status, 404);
    const settingsPath = `${chatPath}/settings`;
    const contextA = { world: '雨夜書店', instructions: '用書信形式回答', systemPrompt: '扮演書店管理員' };
    const contextB = { world: '木星空間站', instructions: '用任務簡報回答', systemPrompt: '扮演值班導航員' };
    assert.equal((await call(settingsPath, { ...alice, body: { context: { world: [] } } })).status, 400);
    assert.equal((await call(settingsPath, { ...alice, body: { context: { systemPrompt: 'x'.repeat(4001) } } })).status, 400);
    assert.equal((await call(settingsPath, { ...alice, body: { context: contextA }, origin: 'https://other.test' })).status, 403);
    assert.equal((await call(settingsPath, bob)).status, 404);
    assert.equal((await call(settingsPath, { ...bob, body: { context: contextB } })).status, 404);
    const oldRoom = crypto.randomUUID();
    db.prepare('INSERT INTO chats (id,owner,title,updated) VALUES (?,?,?,?)').bind(oldRoom, 'alice', '既有聊天室', Date.now()).run();
    assert.deepEqual((await (await call(`/api/tavern/chats/${oldRoom}`, alice)).json()).settings, {});
    const firstGeneration = { style: 'witty', temperature: 0.8 };
    await call(settingsPath, { ...alice, body: { context: contextA } });
    await call(settingsPath, { ...alice, body: { context: { world: contextA.world, instructions: contextA.instructions } } });
    await call(settingsPath, { ...alice, body: { generation: firstGeneration } });
    const second = await (await call('/api/tavern/chats', { ...alice, body: {
        settings: { context: contextB, generation: { style: 'concise', temperature: 0.2 } },
    } })).json();
    const secondPath = `/api/tavern/chats/${second.id}`;
    assert.deepEqual((await (await call(settingsPath, alice)).json()).settings, { context: contextA, generation: firstGeneration });

    await mac.step();
    assert.equal(starts, 0);
    const approvedRequest = await call('/api/tavern/request', { ...alice, body: {} });
    assert.equal(approvedRequest.status, 201);
    const { approval } = await approvedRequest.json();
    assert.equal(approval.state, 'pending');
    assert.equal((await call('/api/tavern/request', { ...alice, body: {} })).status, 200);
    assert.equal(notifications.length, 1);
    await mac.step();
    assert.equal(starts, 0);
    const customId = notifications[0].components[0].components[0].custom_id;
    assert.equal((await call('/api/discord/interactions', { body: { type: 3 } })).status, 401);
    assert.equal((await (await approve(customId, '555555555555555555')).json()).type, 4);
    await mac.step();
    assert.equal(starts, 0);
    assert.equal((await (await approve(customId)).json()).type, 7);
    await approve(customId);
    await mac.step();
    assert.equal(starts, 1);
    const status = await (await call('/api/tavern/status', alice)).json();
    assert.equal(status.approval.state, 'ready');

    const nearExpiry = Date.now() + 2_000;
    db.prepare('UPDATE approvals SET expires=? WHERE id=?').bind(nearExpiry, approval.id).run();
    const result = await call(chatPath, { ...alice, body: { text: 'Alice private test' } });
    assert.equal(result.status, 202);
    const { job } = await result.json();
    const queued = await db.prepare('SELECT expires FROM jobs WHERE id=?').bind(job).first();
    assert.ok(queued.expires > nearExpiry);
    assert.ok((await (await call('/api/tavern/status', alice)).json()).approval.expires > nearExpiry);
    assert.equal((await call(chatPath, { ...alice, body: { text: 'concurrent' } })).status, 409);
    assert.equal((await call(secondPath, { ...alice, body: { text: '另一間聊天室' } })).status, 202);
    sleeping = true;
    await mac.step();
    assert.equal(starts, 1);
    assert.equal(upstreamRequest.model, model);
    assert.equal(upstreamRequest.temperature, 0.8);
    assert.equal(upstreamRequest.messages[0].role, 'system');
    assert.ok(upstreamRequest.messages[0].content.startsWith(contextA.systemPrompt));
    assert.match(upstreamRequest.messages[0].content, /雨夜書店[\s\S]*用書信形式回答/);
    assert.doesNotMatch(JSON.stringify(upstreamRequest.messages), /值班導航員|木星空間站|另一間聊天室/);
    await mac.step();
    assert.equal(upstreamRequest.temperature, 0.2);
    assert.ok(upstreamRequest.messages[0].content.startsWith(contextB.systemPrompt));
    assert.match(upstreamRequest.messages[0].content, /木星空間站[\s\S]*用任務簡報回答/);
    assert.doesNotMatch(JSON.stringify(upstreamRequest.messages), /書店管理員|雨夜書店|Alice private test/);
    assert.deepEqual((await (await call(secondPath, alice)).json()).messages.map(message => message.content),
        ['另一間聊天室', 'model answer']);
    const saved = await (await call(chatPath, alice)).json();
    assert.deepEqual(saved.messages.map(message => message.content), ['Alice private test', 'model answer']);
    assert.equal(saved.job.state, 'done');
    assert.deepEqual(await (await call('/api/tavern/chats', bob)).json(), { chats: [] });
    assert.equal((await call(chatPath, bob)).status, 404);
    assert.equal((await (await call('/api/tavern/status', bob)).json()).approval, null);

    const original = '前文 🐉\n\n  只改這句\n後文\t。';
    upstreamReply = original;
    assert.equal((await call(chatPath, { ...alice, body: { text: '請再寫一段' } })).status, 202);
    await mac.step();
    const start = original.indexOf('只改這句');
    const rewrite = { index: 3, start, end: start + '只改這句'.length, instruction: '改成兩行' };
    assert.equal((await call(chatPath, { ...bob, body: { rewrite } })).status, 404);
    assert.equal((await call(chatPath, { ...alice, body: { rewrite: { ...rewrite, index: 2 } } })).status, 400);
    assert.equal((await call(chatPath, { ...alice, body: { rewrite: { ...rewrite, end: 500 } } })).status, 400);
    assert.equal((await call(chatPath, { ...alice, body: { rewrite } })).status, 202);
    upstreamReply = '新段落\n    第二行';
    await mac.step();
    assert.deepEqual(JSON.parse(upstreamRequest.messages.at(-1).content), {
        instruction: '改成兩行', selected: '只改這句', before: '前文 🐉\n\n  ', after: '\n後文\t。',
    });
    const rewritten = await (await call(chatPath, alice)).json();
    assert.equal(rewritten.messages[3].content, original);
    assert.equal(rewritten.messages.at(-1).content, '前文 🐉\n\n  新段落\n    第二行\n後文\t。');
    assert.deepEqual(rewritten.messages.at(-1).rewrite, rewrite);
    assert.equal((await call(chatPath, { ...alice, body: { retry: 0 } })).status, 400);
    assert.equal((await call(chatPath, { ...bob, body: { retry: 5 } })).status, 404);
    assert.equal((await call(chatPath, { ...alice, body: { retry: 5 } })).status, 202);
    upstreamReply = '再寫一版';
    await mac.step();
    const retriedRewrite = await (await call(chatPath, alice)).json();
    assert.deepEqual(retriedRewrite.messages.slice(0, 6), rewritten.messages);
    assert.equal(retriedRewrite.messages.at(-1).content, '前文 🐉\n\n  再寫一版\n後文\t。');
    assert.equal(retriedRewrite.messages.at(-1).retryOf, 5);
    assert.equal((await call(chatPath, { ...alice, body: { retry: 1 } })).status, 202);
    upstreamReply = '新回覆';
    await mac.step();
    assert.equal(upstreamRequest.messages.at(-1).content, 'Alice private test');
    const retriedChat = await (await call(chatPath, alice)).json();
    assert.equal(retriedChat.messages[1].content, 'model answer');
    assert.equal(retriedChat.messages.at(-1).content, '新回覆');

    const editPath = `${chatPath}/edit`;
    const edit = { index: 0, original: 'Alice private test', text: '編輯後的提問' };
    assert.equal((await call(editPath, { ...bob, body: edit })).status, 404);
    assert.equal((await call(editPath, { ...alice, body: { index: 1, original: 'model answer', text: '改 AI 文字' } })).status, 400);
    const editedChat = await (await call(editPath, { ...alice, body: edit })).json();
    assert.equal(editedChat.title, edit.text);
    assert.equal(editedChat.messages[0].content, edit.text);
    assert.deepEqual(editedChat.messages.slice(1), retriedChat.messages.slice(1));
    assert.equal((await call(editPath, { ...alice, body: edit })).status, 409);
    assert.equal((await call(chatPath, { ...alice, body: { retry: 1 } })).status, 202);
    assert.equal((await call(editPath, { ...alice, body: { ...edit, original: edit.text } })).status, 409);
    await mac.step();
    assert.equal(upstreamRequest.messages.at(-1).content, edit.text);

    const rewriteEdit = { index: 6, original: retriedRewrite.messages[6].content, text: '改成第三種語氣' };
    const editedRewrite = await (await call(editPath, { ...alice, body: rewriteEdit })).json();
    assert.equal(editedRewrite.messages[6].content, `改寫選取文字：${rewriteEdit.text}`);
    assert.equal((await call(chatPath, { ...alice, body: { retry: 7 } })).status, 202);
    await mac.step();
    const retryInput = JSON.parse(upstreamRequest.messages.at(-1).content);
    assert.equal(retryInput.instruction, rewriteEdit.text);
    assert.equal(retryInput.selected, '只改這句');

    db.prepare('UPDATE approvals SET expires=0 WHERE id=?').bind(approval.id).run();
    assert.equal((await (await call('/api/tavern/status', alice)).json()).approval.state, 'expired');
    const finalEdit = { ...edit, original: edit.text, text: '未連線時也可儲存' };
    assert.equal((await call(editPath, { ...alice, body: finalEdit })).status, 200);
    assert.equal((await (await call(chatPath, alice)).json()).messages[0].content, finalEdit.text);
    assert.equal((await call(chatPath, { ...alice, body: { text: 'after timeout' } })).status, 409);

    env.TAVERN_APPROVER_EMAIL = 'Bob@example.test';
    db.prepare('UPDATE approvals SET created=0 WHERE owner=?').bind(alice.user).run();
    const requested = await (await call('/api/tavern/request', { ...alice, body: {} })).json();
    const requestId = requested.approval.id;
    assert.equal(requested.approval.state, 'pending');
    const waiting = await (await call('/api/tavern/status', alice)).json();
    assert.equal(waiting.approvalChannel, 'web');
    assert.equal(waiting.canApprove, false);
    assert.equal((await (await call('/api/tavern/status', bob)).json()).canApprove, true);
    assert.equal((await call('/api/tavern/approvals', alice)).status, 403);
    const approvals = await (await call('/api/tavern/approvals', bob)).json();
    assert.equal(approvals.requests[0].id, requestId);
    const decisionPath = `/api/tavern/approvals/${requestId}`;
    assert.equal((await call(decisionPath, { ...alice, body: { decision: 'approve' } })).status, 403);
    assert.equal((await call(decisionPath, { ...bob, origin: 'https://other.test', body: { decision: 'approve' } })).status, 403);
    assert.equal((await approve(`tavern:approve:${requestId}`)).status, 401);
    assert.equal((await call(decisionPath, { ...bob, body: { decision: 'reject' } })).status, 200);
    assert.equal((await (await call('/api/tavern/status', alice)).json()).approval.state, 'rejected');
    assert.equal((await call(decisionPath, { ...bob, body: { decision: 'approve' } })).status, 409);

    db.prepare('UPDATE approvals SET created=0 WHERE owner=?').bind(alice.user).run();
    const next = await (await call('/api/tavern/request', { ...alice, body: {} })).json();
    const nextPath = `/api/tavern/approvals/${next.approval.id}`;
    assert.equal((await call(nextPath, { ...bob, body: { decision: 'approve' } })).status, 200);
    await mac.step();
    assert.equal((await (await call('/api/tavern/status', alice)).json()).approval.state, 'ready');
    assert.deepEqual((await (await call('/api/tavern/approvals', bob)).json()).requests, []);
    assert.equal(notifications.length, 1);
    console.log('通過：帳號與聊天室隔離、獨立世界觀和生成設定、批准者驗證、避免重複啟動、閒置重載、過期重新申請。');
} finally {
    db.close();
}
