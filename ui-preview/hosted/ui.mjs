const approvalLabels = {
    pending: '等朋友按 Discord OK',
    approved: '已批准，等 Mac 準備模型',
    ready: '已批准，可以開始聊天',
    failed: '請求未完成',
    expired: '使用權已到期',
};
const modelLabels = {
    offline: 'Mac 未連線', stopped: '模型服務已停', loading: '正在載入',
    sleeping: '模型已退位', ready: '模型就緒', error: '模型連線異常',
};
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const testMode = document.body.hasAttribute('data-test-mode');

async function api(path, body) {
    const response = await fetch(`/api/tavern${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '網站暫時無法處理請求。');
    return data;
}

export function createHostedUi({ addMessage, resizeInput, openPanel, closeFloatingSidebar, isNarrow, renderAccount }) {
    const input = $('#message-input');
    const conversation = $('#conversation');
    const send = $('#send-button');
    const dialog = $('#utility-panel');
    const panelContent = $('#panel-content');
    const panelStatus = $('#panel-status');
    const chatStatus = $('#chat-status');
    let status;
    const rooms = new Map();
    const emptyRoom = () => ({ id: null, title: '新聊天', messages: [], settings: {}, draft: '', notice: '' });
    let room = emptyRoom();
    let selection = 0;
    let statusTimer;
    let renderedModelPanel;

    async function refreshStatus() {
        clearTimeout(statusTimer);
        const modelPanelOpen = () => renderedModelPanel?.isConnected && dialog.open;
        try {
            status = await api('/status');
            const phase = status.approval?.state;
            $('#current-model').textContent = status.model;
            $('#connection-status span').textContent = modelLabels[status.state];
            if (modelPanelOpen()) {
                $('#hosted-model-state').textContent = modelLabels[status.state];
                $('#hosted-approval-state').textContent = approvalLabels[phase] || '尚未送出使用請求';
                $('#request-model').disabled = ['pending', 'approved', 'ready'].includes(phase);
                const simulate = $('#simulate-approval');
                if (simulate) simulate.disabled = phase !== 'pending';
            }
        } catch (error) {
            if (modelPanelOpen()) panelStatus.textContent = error.message;
        } finally {
            if (status && document.visibilityState === 'visible'
                && (modelPanelOpen() || ['pending', 'approved'].includes(status.approval?.state))) {
                statusTimer = setTimeout(refreshStatus, 2500);
            }
        }
    }

    function modelPanel() {
        if (!status) {
            panelContent.innerHTML = '<p class="panel-note">請先登入有模型使用權的帳號。</p>';
            return;
        }
        panelContent.innerHTML = `
            <div id="hosted-model-panel">
                <p class="panel-note"><strong id="hosted-model-name"></strong><br>
                    <span id="hosted-model-state"></span> · <span id="hosted-approval-state"></span></p>
                <div class="generation-actions">
                    <button type="button" id="request-model" disabled>送出使用請求</button>
                    ${testMode ? '<button type="button" id="simulate-approval" disabled>模擬朋友按 OK</button>' : ''}
                </div>
            </div>`;
        renderedModelPanel = $('#hosted-model-panel');
        $('#hosted-model-name').textContent = status.model;
        $('#request-model').onclick = async event => {
            event.currentTarget.disabled = true;
            panelStatus.textContent = '';
            try {
                await api('/request', {});
            } catch (error) {
                if (dialog.open && renderedModelPanel?.isConnected) panelStatus.textContent = error.message;
            }
            await refreshStatus();
        };
        if (testMode) $('#simulate-approval').onclick = async () => {
            const response = await fetch('/_test/approve', { method: 'POST' });
            if (!response.ok) panelStatus.textContent = '模擬批准失敗。';
            await refreshStatus();
        };
        queueMicrotask(refreshStatus);
    }

    function renderRoom(showNewest = false) {
        $('#chat-title').textContent = room.title;
        $$('#conversation .message').forEach(message => message.remove());
        $$('.chat-row').forEach(row => row.classList.toggle('is-active', row.dataset.chatId === room.id));
        for (const [index, message] of room.messages.entries()) {
            const article = addMessage(message.content, message.role);
            article.dataset.messageIndex = String(index);
            article.querySelector('[data-action="edit"]')?.remove();
            const author = article.querySelector('.message__identity strong');
            if (author) author.textContent = status.model;
            if (message.rewrite) article.querySelector('.message__identity small').textContent = '改寫後全文';
            if (message.role === 'assistant' && !message.rewrite
                && room.messages[index - 1]?.content.startsWith('改寫選取文字：')) {
                article.dataset.legacyRewrite = room.messages[index - 1].content.slice('改寫選取文字：'.length);
            }
        }
        input.value = room.draft;
        resizeInput();
        input.readOnly = send.disabled = !!room.busy;
        chatStatus.textContent = room.notice;
        const newest = showNewest && conversation.querySelector('.message--assistant:last-of-type');
        const top = newest
            ? conversation.scrollTop + newest.getBoundingClientRect().top - conversation.getBoundingClientRect().top - 12
            : conversation.scrollHeight;
        conversation.scrollTo({ top, behavior: 'instant' });
    }

    function activateRoom(next) {
        if (!room.busy) room.draft = input.value;
        room = next;
        renderRoom();
    }

    async function readRoom(id) {
        const cached = rooms.get(id);
        if (cached?.busy || cached?.saving) return cached;
        const previousMessages = cached?.messages;
        const previousSettings = cached?.settings;
        const chat = await api(`/chats/${id}`);
        const loaded = rooms.get(id);
        if (loaded) {
            if (!loaded.busy && !loaded.saving && loaded.messages === previousMessages && loaded.settings === previousSettings) {
                Object.assign(loaded, chat);
            }
            return loaded;
        }
        const next = Object.assign(emptyRoom(), chat);
        rooms.set(id, next);
        return next;
    }

    async function refreshChats() {
        const { chats } = await api('/chats');
        const group = $('#chat-history .chat-group');
        $$('#chat-history .chat-row').forEach(row => row.remove());
        for (const chat of chats) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'chat-row';
            row.dataset.title = chat.title;
            row.dataset.chatId = chat.id;
            row.classList.toggle('is-active', chat.id === room.id);
            row.innerHTML = '<i class="fa-solid fa-comments" aria-hidden="true"></i><span></span>';
            row.querySelector('span').textContent = chat.title;
            row.onclick = async () => {
                const selected = ++selection;
                try {
                    const next = await readRoom(chat.id);
                    if (selected !== selection || dialog.open) return;
                    activateRoom(next);
                    if (isNarrow()) closeFloatingSidebar();
                } catch (error) {
                    if (selected === selection) chatStatus.textContent = error.message;
                }
            };
            group.append(row);
        }
        return chats;
    }

    function newChat() {
        if (!status) return;
        selection++;
        activateRoom(emptyRoom());
        if (isNarrow()) closeFloatingSidebar();
        input.focus();
    }

    function getSettings() {
        return room.settings;
    }

    async function saveSettings(patch) {
        if (!status) throw new Error('請先登入。');
        const target = room;
        if (target.saving || (!target.id && target.busy)) throw new Error('聊天室正在建立，請稍後再試。');
        target.saving = true;
        try {
            if (target.id) {
                const { settings } = await api(`/chats/${target.id}/settings`, patch);
                target.settings = settings;
            } else {
                Object.assign(target, await api('/chats', { settings: patch }));
                rooms.set(target.id, target);
                await refreshChats();
            }
        } finally {
            target.saving = false;
        }
    }

    async function queueMessage(payload) {
        const rewriting = Object.hasOwn(payload, 'rewrite');
        const retrying = Object.hasOwn(payload, 'retry');
        if (room.busy || room.saving || !status) {
            if (rewriting || retrying) chatStatus.textContent = '請等目前的操作完成後再試。';
            return;
        }
        const target = room;
        target.busy = true;
        target.draft = input.value;
        send.disabled = true;
        input.readOnly = true;
        let completed = false;
        try {
            status = await api('/status');
            if (status.approval?.state !== 'ready') {
                if (rewriting || retrying) target.notice = '請先取得模型使用權，再試一次。';
                if (target === room) openPanel('models');
                return;
            }
            if (!target.id) {
                Object.assign(target, await api('/chats', {}));
                rooms.set(target.id, target);
                await refreshChats();
            }
            const path = `/chats/${target.id}`;
            const { job } = await api(path, payload);
            target.notice = rewriting ? '模型正在改寫選取文字…' : retrying ? '模型正在重新回覆…' : '模型正在處理…';
            if (target === room) chatStatus.textContent = target.notice;
            const deadline = Date.now() + 305_000;
            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 1100));
                const chat = await api(path);
                if (chat.job?.id !== job) throw new Error('工作狀態已變更，請重新開啟聊天室。');
                if (chat.job.state === 'failed') throw new Error(chat.job.error);
                if (chat.job.state !== 'done') continue;
                target.title = chat.title;
                target.messages = chat.messages;
                if (!rewriting && !retrying) target.draft = '';
                target.notice = '';
                completed = true;
                await refreshChats();
                return;
            }
            throw new Error('等待模型逾時，請重新開啟聊天室確認。');
        } catch (error) {
            target.notice = error.message;
        } finally {
            target.busy = false;
            if (target === room) renderRoom(completed && (rewriting || retrying));
        }
    }

    async function init() {
        $$('#conversation .message').forEach(message => message.remove());
        $('#chat-title').textContent = '酒館';
        $('#chat-history').innerHTML = '<section class="chat-group"><h2>我的聊天室</h2></section>';
        send.disabled = true;
        input.disabled = true;
        const signIn = testMode ? '/_test/signin' : '/signin-with-chatgpt?return_to=%2F';
        renderAccount({}, testMode ? '測試登入' : '登入', signIn);
        api('/account').then(profile => {
            if (profile.email) renderAccount(profile, testMode ? '切換測試帳號' : '登出',
                testMode ? signIn : '/signout-with-chatgpt?return_to=%2F');
        }).catch(() => {});
        try {
            status = await api('/status');
            $('#current-model').textContent = status.model;
            $('#chat-title').textContent = '新聊天';
            $('.conversation__intro p').textContent = testMode ? '本機整合測試 · Discord 與模型皆為模擬' : '在「模型」送出使用請求。';
            input.placeholder = '輸入訊息';
            const chats = await refreshChats();
            if (chats[0] && selection === 0) {
                const first = await readRoom(chats[0].id);
                if (selection === 0 && !dialog.open) activateRoom(first);
            }
            send.disabled = false;
            input.disabled = false;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') refreshStatus();
            });
            refreshStatus();
        } catch (error) {
            $('.conversation__intro p').textContent = error.message;
        }
    }

    return { init, modelPanel, newChat, getSettings, saveSettings,
        sendMessage: text => queueMessage({ text }),
        rewriteMessage: rewrite => queueMessage({ rewrite }),
        retryMessage: retry => queueMessage({ retry }),
        saveAccountPreferences: preferences => api('/account', preferences) };
}
