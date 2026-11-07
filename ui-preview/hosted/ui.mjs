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

export function createHostedUi({ addMessage, escapeHtml, resizeInput, openPanel, closeFloatingSidebar, isNarrow, getGeneration }) {
    const input = $('#message-input');
    const send = $('#send-button');
    const dialog = $('#utility-panel');
    const panelContent = $('#panel-content');
    const panelStatus = $('#panel-status');
    const chatStatus = $('#chat-status');
    let status;
    let chatId;
    let busy = false;
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

    function showChat(chat) {
        chatId = chat.id;
        $('#chat-title').textContent = chat.title;
        $$('#conversation .message').forEach(message => message.remove());
        $$('.chat-row').forEach(row => row.classList.toggle('is-active', row.dataset.chatId === chatId));
        for (const message of chat.messages) {
            const article = addMessage(message.content, message.role);
            article.querySelector('.message__body').innerHTML = `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`;
            article.querySelector('[data-action="edit"]')?.remove();
            const author = article.querySelector('.message__identity strong');
            if (author) author.textContent = status.model;
        }
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
            row.classList.toggle('is-active', chat.id === chatId);
            row.innerHTML = '<i class="fa-solid fa-comments" aria-hidden="true"></i><span></span>';
            row.querySelector('span').textContent = chat.title;
            row.onclick = async () => {
                if (busy) return;
                try {
                    showChat(await api(`/chats/${chat.id}`));
                    input.value = '';
                    resizeInput();
                    chatStatus.textContent = '';
                    if (isNarrow()) closeFloatingSidebar();
                } catch (error) {
                    chatStatus.textContent = error.message;
                }
            };
            group.append(row);
        }
        return chats;
    }

    function newChat() {
        if (!status || busy) return;
        input.value = '';
        resizeInput();
        chatStatus.textContent = '';
        showChat({ id: null, title: '新聊天', messages: [] });
        if (isNarrow()) closeFloatingSidebar();
        input.focus();
    }

    async function sendMessage(text) {
        if (busy || !status) return;
        busy = true;
        send.disabled = true;
        input.readOnly = true;
        try {
            status = await api('/status');
            if (status.approval?.state !== 'ready') {
                openPanel('models');
                return;
            }
            if (!chatId) showChat(await api('/chats', {}));
            const path = `/chats/${chatId}`;
            const { job } = await api(path, { text, generation: getGeneration() });
            chatStatus.textContent = '模型正在處理…';
            const deadline = Date.now() + 305_000;
            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 1100));
                const chat = await api(path);
                if (chat.job?.id !== job) throw new Error('工作狀態已變更，請重新開啟聊天室。');
                if (chat.job.state === 'failed') throw new Error(chat.job.error);
                if (chat.job.state !== 'done') continue;
                showChat(chat);
                input.value = '';
                resizeInput();
                chatStatus.textContent = '';
                await refreshChats();
                return;
            }
            throw new Error('等待模型逾時，請重新開啟聊天室確認。');
        } catch (error) {
            chatStatus.textContent = error.message;
        } finally {
            busy = false;
            input.readOnly = false;
            send.disabled = false;
        }
    }

    async function init() {
        $$('#conversation .message').forEach(message => message.remove());
        $('#chat-title').textContent = '酒館';
        $('#chat-history').innerHTML = '<section class="chat-group"><h2>我的聊天室</h2></section>';
        send.disabled = true;
        input.disabled = true;
        const account = document.createElement('a');
        account.className = 'hosted-account';
        account.textContent = testMode ? '測試登入' : '登入';
        account.href = testMode ? '/_test/signin' : '/signin-with-chatgpt?return_to=%2F';
        account.target = '_top';
        $('.topbar__actions').prepend(account);
        try {
            status = await api('/status');
            account.textContent = testMode ? '切換測試帳號' : '登出';
            if (!testMode) account.href = '/signout-with-chatgpt?return_to=%2F';
            $('#current-model').textContent = status.model;
            $('#chat-title').textContent = '新聊天';
            $('.conversation__intro p').textContent = testMode ? '本機整合測試 · Discord 與模型皆為模擬' : '在「模型」送出使用請求。';
            input.placeholder = '輸入訊息';
            const chats = await refreshChats();
            if (chats[0]) showChat(await api(`/chats/${chats[0].id}`));
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

    return { init, modelPanel, newChat, sendMessage };
}
