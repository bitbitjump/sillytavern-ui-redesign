(function friendMobileUi() {
    'use strict';

    const scriptUrl = document.currentScript?.src || '';
    const mobileQuery = window.matchMedia('(max-width: 820px)');
    const isPreview = Boolean(document.getElementById('preview-mode')) || /\/preview\/app\.html$/i.test(window.location.pathname);
    const selectors = {
        chatList: '#option_select_chat',
        newChat: '#option_start_new_chat',
        characters: '#rightNavDrawerIcon',
        settings: '#leftNavDrawerIcon',
    };

    let contextTimer;
    let resizeTimer;
    let recentChats = [];
    let recentChatActions;

    function clickExistingControl(selector) {
        const control = document.querySelector(selector);
        if (!control) {
            return;
        }

        closeTools();
        control.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
    }

    function closeTools() {
        document.body.classList.remove('friend-mobile-tools-open', 'friend-desktop-tools-open');
        document.querySelector('[data-friend-action="tools"]')?.setAttribute('aria-expanded', 'false');
        document.querySelector('[data-friend-action="desktopTools"]')?.setAttribute('aria-expanded', 'false');
    }

    function toggleTools() {
        const isOpen = document.body.classList.toggle('friend-mobile-tools-open');
        document.querySelector('[data-friend-action="tools"]')?.setAttribute('aria-expanded', String(isOpen));
    }

    function toggleDesktopTools() {
        const isOpen = document.body.classList.toggle('friend-desktop-tools-open');
        document.querySelector('[data-friend-action="desktopTools"]')?.setAttribute('aria-expanded', String(isOpen));
    }

    function toggleDesktopSidebar(forceCollapsed) {
        const shouldCollapse = typeof forceCollapsed === 'boolean'
            ? forceCollapsed
            : !document.body.classList.contains('friend-sidebar-collapsed');
        document.body.classList.toggle('friend-sidebar-collapsed', shouldCollapse);
        document.getElementById('friend-desktop-sidebar')?.setAttribute('aria-hidden', String(shouldCollapse));
        document.querySelectorAll('[data-friend-sidebar-toggle]').forEach((button) => {
            button.setAttribute('aria-expanded', String(!shouldCollapse));
            button.setAttribute('aria-label', shouldCollapse ? '展開聊天室側欄' : '收起聊天室側欄');
            button.title = shouldCollapse ? '展開聊天室側欄' : '收起聊天室側欄';
        });
        try {
            window.localStorage.setItem('friend-sidebar-collapsed', String(shouldCollapse));
        } catch {
            // Storage can be unavailable in private or embedded contexts.
        }
    }

    function setMobileSidebar(open) {
        const shouldOpen = typeof open === 'boolean'
            ? open
            : !document.body.classList.contains('friend-mobile-sidebar-open');
        document.body.classList.toggle('friend-mobile-sidebar-open', shouldOpen);
        document.getElementById('friend-desktop-sidebar')?.setAttribute('aria-hidden', String(!shouldOpen && mobileQuery.matches));
        document.querySelector('[data-friend-action="mobileSidebar"]')?.setAttribute('aria-expanded', String(shouldOpen));
    }

    function createAction(action, icon, label, description) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'friend-mobile-action';
        button.dataset.friendAction = action;
        button.setAttribute('aria-label', description);
        button.title = description;
        button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;

        if (action === 'tools') {
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-controls', 'top-settings-holder');
            button.addEventListener('click', toggleTools);
        } else {
            button.addEventListener('click', () => clickExistingControl(selectors[action]));
        }

        return button;
    }

    function createHeader() {
        const topBar = document.getElementById('top-bar');
        if (!topBar || document.getElementById('friend-mobile-header')) {
            return;
        }

        const header = document.createElement('header');
        header.id = 'friend-mobile-header';
        header.setAttribute('aria-label', '手機版聊天導覽');

        const context = document.createElement('div');
        context.className = 'friend-mobile-context';
        context.innerHTML = `
            <strong id="friend-mobile-title">選擇一位角色</strong>
            <span id="friend-mobile-subtitle">
                <span id="friend-mobile-status" data-state="offline" role="status" aria-live="polite">正在確認連線</span>
            </span>`;

        const sidebarButton = document.createElement('button');
        sidebarButton.type = 'button';
        sidebarButton.className = 'friend-mobile-icon-button';
        sidebarButton.dataset.friendAction = 'mobileSidebar';
        sidebarButton.setAttribute('aria-label', '開啟聊天室');
        sidebarButton.setAttribute('aria-expanded', 'false');
        sidebarButton.innerHTML = '<i class="fa-solid fa-bars" aria-hidden="true"></i>';
        sidebarButton.addEventListener('click', () => setMobileSidebar());

        const actions = document.createElement('nav');
        actions.className = 'friend-mobile-actions';
        actions.setAttribute('aria-label', '聊天操作');
        actions.append(
            createAction('characters', 'fa-user-group', '角色', '選擇或管理角色'),
            createAction('tools', 'fa-ellipsis', '更多', '開啟完整設定工具'),
        );

        header.append(sidebarButton, context, actions);
        topBar.append(header);
    }

    function createDesktopAction(action, icon, label, description) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'friend-desktop-action';
        button.dataset.friendAction = action;
        button.setAttribute('aria-label', description);
        button.title = description;
        button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;
        if (action === 'desktopTools') {
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-controls', 'top-settings-holder');
            button.addEventListener('click', toggleDesktopTools);
        } else {
            button.addEventListener('click', () => clickExistingControl(selectors[action]));
        }
        return button;
    }

    function createDesktopSidebar() {
        if (document.getElementById('friend-desktop-sidebar')) {
            return;
        }

        const sidebar = document.createElement('aside');
        sidebar.id = 'friend-desktop-sidebar';
        sidebar.setAttribute('aria-label', '主要導覽');
        sidebar.innerHTML = `
            <div class="friend-sidebar-brand">
                <span class="friend-sidebar-mark"><i class="fa-solid fa-martini-glass-citrus" aria-hidden="true"></i></span>
                <span><strong>酒館</strong><small>AI 故事與角色聊天</small></span>
                <button type="button" class="friend-sidebar-brand-action" data-friend-sidebar-toggle aria-expanded="true" aria-label="收起聊天室側欄" title="收起聊天室側欄">
                    <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
                </button>
            </div>
            <button type="button" class="friend-sidebar-new" data-sidebar-action="newChat">
                <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i><span>開始新聊天</span>
            </button>
            <label class="friend-sidebar-search">
                <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                <input id="friend-sidebar-search-input" type="search" placeholder="搜尋聊天室" autocomplete="off" aria-label="搜尋聊天室">
            </label>
            <div class="friend-sidebar-chat-heading">
                <span>聊天室</span>
                <button type="button" data-sidebar-action="chatList" title="開啟完整聊天管理" aria-label="開啟完整聊天管理">
                    <i class="fa-solid fa-list" aria-hidden="true"></i>
                </button>
            </div>
            <nav id="friend-sidebar-chat-list" class="friend-sidebar-chat-list" aria-label="最近聊天室" aria-live="polite">
                <div class="friend-sidebar-loading"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i><span>載入聊天室…</span></div>
            </nav>
            <nav class="friend-sidebar-utilities" aria-label="角色與設定">
                <button type="button" class="friend-sidebar-utility" data-sidebar-action="characters" title="選擇或管理角色">
                    <i class="fa-solid fa-user-group" aria-hidden="true"></i><span>角色</span>
                </button>
                <button type="button" class="friend-sidebar-utility" data-sidebar-action="settings" title="模型連線與回覆設定">
                    <i class="fa-solid fa-sliders" aria-hidden="true"></i><span>模型</span>
                </button>
                <button type="button" class="friend-sidebar-utility" data-friend-action="desktopTools" title="世界書、外觀與完整工具">
                    <i class="fa-solid fa-table-cells-large" aria-hidden="true"></i><span>工具</span>
                </button>
            </nav>
            <div class="friend-sidebar-footer">
                <span id="friend-sidebar-status" data-state="offline">正在確認連線</span>
            </div>`;

        sidebar.querySelectorAll('[data-sidebar-action]').forEach((button) => {
            button.addEventListener('click', () => clickExistingControl(selectors[button.dataset.sidebarAction]));
        });
        sidebar.querySelectorAll('[data-friend-action="desktopTools"]').forEach((button) => button.addEventListener('click', toggleDesktopTools));
        sidebar.querySelectorAll('[data-friend-sidebar-toggle]').forEach((button) => button.addEventListener('click', () => toggleDesktopSidebar()));
        sidebar.querySelector('#friend-sidebar-search-input')?.addEventListener('input', renderRecentChats);
        document.body.prepend(sidebar);

        const backdrop = document.createElement('button');
        backdrop.type = 'button';
        backdrop.id = 'friend-mobile-sidebar-backdrop';
        backdrop.setAttribute('aria-label', '關閉聊天室');
        backdrop.addEventListener('click', () => setMobileSidebar(false));
        document.body.prepend(backdrop);
    }

    function getPreviewChats() {
        return [
            { chat_name: '雨夜重逢 · 第一章', char_name: '書店寫作助手', date_short: '剛剛', group_label: '今天', chat_items: 2, icon: 'fa-cloud-rain', preview: true, active: true },
            { chat_name: '舊書店的早晨', char_name: '書店寫作助手', date_short: '昨天', group_label: '昨天', chat_items: 18, icon: 'fa-book-open', preview: true },
            { chat_name: '角色設定討論', char_name: '世界觀整理員', date_short: '10 月 30 日', group_label: '過去 7 天', chat_items: 9, icon: 'fa-mug-hot', preview: true },
        ];
    }

    function createRecentChatButton(chat) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'friend-sidebar-chat';
        button.dataset.chatName = chat.chat_name || '';
        button.dataset.searchText = `${chat.chat_name || ''} ${chat.char_name || ''}`.toLocaleLowerCase();

        const currentChat = document.getElementById('selected_chat_pole')?.value?.trim();
        const isActive = chat.preview ? Boolean(chat.active) : Boolean(currentChat && currentChat === chat.chat_name);
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-current', isActive ? 'page' : 'false');

        const visual = document.createElement('span');
        visual.className = 'friend-sidebar-chat-visual';
        if (chat.char_thumbnail) {
            const image = document.createElement('img');
            image.src = chat.char_thumbnail;
            image.alt = '';
            visual.append(image);
        } else {
            visual.innerHTML = `<i class="fa-solid ${chat.icon || 'fa-message'}" aria-hidden="true"></i>`;
        }

        const copy = document.createElement('span');
        copy.className = 'friend-sidebar-chat-copy';
        const name = document.createElement('strong');
        name.textContent = chat.chat_name || chat.char_name || '未命名聊天室';
        const meta = document.createElement('small');
        const count = Number.isFinite(chat.chat_items) ? ` · ${chat.chat_items} 則` : '';
        meta.textContent = `${chat.char_name || '聊天室'}${chat.date_short ? ` · ${chat.date_short}` : ''}${count}`;
        copy.append(name, meta);
        button.append(visual, copy);

        button.addEventListener('click', async () => {
            if (chat.preview) {
                recentChats.forEach((item) => { item.active = item === chat; });
                document.getElementById('selected_chat_pole').value = chat.chat_name;
                document.getElementById('rm_button_selected_ch').querySelector('h2').textContent = chat.char_name;
                renderRecentChats();
                updateContext();
                setMobileSidebar(false);
                return;
            }
            if (!recentChatActions) return;
            if (chat.is_group) {
                await recentChatActions.openRecentGroupChat(chat.group, chat.chat_name);
            } else {
                await recentChatActions.openRecentCharacterChat(chat.avatar, chat.chat_name);
            }
            renderRecentChats();
            updateContext();
            setMobileSidebar(false);
        });
        return button;
    }

    function renderRecentChats() {
        const list = document.getElementById('friend-sidebar-chat-list');
        if (!list) return;
        const query = document.getElementById('friend-sidebar-search-input')?.value?.trim().toLocaleLowerCase() || '';
        const matches = recentChats.filter((chat) => `${chat.chat_name || ''} ${chat.char_name || ''}`.toLocaleLowerCase().includes(query));
        list.replaceChildren();
        if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'friend-sidebar-empty';
            empty.innerHTML = `<i class="fa-regular fa-message" aria-hidden="true"></i><span>${query ? '找不到符合的聊天室' : '還沒有聊天室'}</span>`;
            list.append(empty);
            return;
        }
        let previousGroup = '';
        matches.forEach((chat, index) => {
            const group = chat.group_label || (index === 0 ? '最近' : '');
            if (group && group !== previousGroup) {
                const label = document.createElement('div');
                label.className = 'friend-sidebar-group-label';
                label.textContent = group;
                list.append(label);
                previousGroup = group;
            }
            list.append(createRecentChatButton(chat));
        });
    }

    async function loadRecentChats() {
        if (isPreview) {
            recentChats = getPreviewChats();
            renderRecentChats();
            return;
        }
        try {
            const moduleUrl = new URL('welcome-screen.js', scriptUrl).href;
            recentChatActions = await import(moduleUrl);
            recentChats = await recentChatActions.getRecentChats();
        } catch (error) {
            console.warn('Friend UI could not load recent chats.', error);
            recentChats = [];
        }
        renderRecentChats();
    }

    function createDesktopContextbar() {
        const shell = document.getElementById('sheld');
        const chat = document.getElementById('chat');
        if (!shell || !chat || document.getElementById('friend-desktop-contextbar')) {
            return;
        }

        const contextbar = document.createElement('header');
        contextbar.id = 'friend-desktop-contextbar';
        contextbar.setAttribute('aria-label', '目前聊天與常用操作');

        const sidebarToggle = document.createElement('button');
        sidebarToggle.type = 'button';
        sidebarToggle.className = 'friend-desktop-sidebar-toggle';
        sidebarToggle.dataset.friendSidebarToggle = '';
        sidebarToggle.setAttribute('aria-expanded', 'true');
        sidebarToggle.setAttribute('aria-label', '收起聊天室側欄');
        sidebarToggle.title = '收起聊天室側欄';
        sidebarToggle.innerHTML = '<i class="fa-solid fa-bars" aria-hidden="true"></i>';
        sidebarToggle.addEventListener('click', () => toggleDesktopSidebar());

        const context = document.createElement('div');
        context.className = 'friend-desktop-context';
        context.innerHTML = `
            <strong id="friend-desktop-title">選擇一位角色</strong>
            <span id="friend-desktop-status" data-state="offline" role="status" aria-live="polite">正在確認連線</span>`;

        const actions = document.createElement('nav');
        actions.className = 'friend-desktop-actions';
        actions.setAttribute('aria-label', '聊天捷徑');
        actions.append(
            createDesktopAction('characters', 'fa-user-group', '角色', '選擇或管理角色'),
            createDesktopAction('settings', 'fa-sliders', '模型', '開啟模型與回覆設定'),
            createDesktopAction('desktopTools', 'fa-ellipsis', '更多', '開啟完整設定工具'),
        );

        contextbar.append(sidebarToggle, context, actions);
        shell.insertBefore(contextbar, chat);
    }

    function getVisible(element) {
        if (!element) {
            return false;
        }

        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function updateContext() {
        const mobileTitle = document.getElementById('friend-mobile-title');
        const mobileStatus = document.getElementById('friend-mobile-status');
        const subtitle = document.getElementById('friend-mobile-subtitle');
        const desktopTitle = document.getElementById('friend-desktop-title');
        const desktopStatus = document.getElementById('friend-desktop-status');
        const sidebarStatus = document.getElementById('friend-sidebar-status');
        if (!mobileTitle || !mobileStatus || !subtitle || !desktopTitle || !desktopStatus || !sidebarStatus) {
            return;
        }

        const characterName = document.querySelector('#rm_button_selected_ch h2')?.textContent?.trim();
        const chatName = document.getElementById('selected_chat_pole')?.value?.trim();
        const sendForm = document.getElementById('send_form');
        const stopButton = document.getElementById('mes_stop');
        const isGenerating = getVisible(stopButton);
        const isConnected = Boolean(sendForm && !sendForm.classList.contains('no-connection'));

        const displayTitle = characterName || '選擇一位角色';
        mobileTitle.textContent = displayTitle;
        mobileTitle.title = characterName || '';
        desktopTitle.textContent = displayTitle;
        desktopTitle.title = characterName || '';
        document.querySelectorAll('.friend-sidebar-chat').forEach((button) => {
            const isActive = Boolean(chatName && button.dataset.chatName === chatName);
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-current', isActive ? 'page' : 'false');
        });

        let state = 'online';
        let stateText = chatName || '準備開始新的對話';
        if (!isConnected) {
            state = 'offline';
            stateText = '酒館或模型尚未連線';
        } else if (isGenerating) {
            state = 'generating';
            stateText = '正在回覆，可隨時停止';
        }

        for (const status of [mobileStatus, desktopStatus]) {
            status.dataset.state = state;
            status.textContent = stateText;
            status.title = chatName || stateText;
        }

        const sidebarState = isPreview ? 'preview' : state;
        const sidebarText = isPreview
            ? '展示模式 · 尚未連接模型'
            : state === 'online'
                ? '模型已連線'
                : state === 'generating'
                    ? '正在產生回覆'
                    : '模型尚未連線';
        sidebarStatus.dataset.state = sidebarState;
        sidebarStatus.textContent = sidebarText;
        sidebarStatus.title = sidebarText;
    }

    function labelSettingsTools() {
        document.querySelectorAll('#top-settings-holder .drawer-toggle').forEach((toggle) => {
            const icon = toggle.querySelector('[title]');
            const title = icon?.getAttribute('title')?.trim() || toggle.getAttribute('title')?.trim() || '設定';
            toggle.dataset.friendLabel = title;
        });
    }

    function makeDivControlAccessible(id, label) {
        const control = document.getElementById(id);
        if (!control) {
            return;
        }

        control.setAttribute('role', 'button');
        control.setAttribute('aria-label', label);
        if (!control.hasAttribute('tabindex')) {
            control.tabIndex = 0;
        }

        control.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
                return;
            }

            event.preventDefault();
            control.click();
        });
    }

    function enhanceComposer() {
        const optionsButton = document.getElementById('options_button');
        if (optionsButton) {
            optionsButton.classList.remove('fa-bars');
            optionsButton.classList.add('fa-plus');
            optionsButton.title = '新增附件或開啟工具';
        }
        makeDivControlAccessible('options_button', '新增附件或開啟工具');
        makeDivControlAccessible('send_but', '傳送訊息');
        makeDivControlAccessible('mes_stop', '停止產生回覆');

        document.getElementById('friend-attach-button')?.remove();
    }

    function dispatchPreviewMessageAction(message, action) {
        message.dispatchEvent(new CustomEvent(`friend-preview-${action}`, {
            bubbles: true,
            detail: { message },
        }));
    }

    function createMessageAction(icon, label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'friend-message-action';
        button.dataset.messageAction = action;
        button.setAttribute('aria-label', label);
        button.title = label;
        button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;
        return button;
    }

    function enhanceMessageActions() {
        document.querySelectorAll('#chat .mes').forEach((message) => {
            if (message.dataset.friendActions === 'true' || message.getAttribute('is_system') === 'true') {
                return;
            }

            const block = message.querySelector('.mes_block');
            const text = message.querySelector('.mes_text');
            if (!block || !text) return;

            message.dataset.friendActions = 'true';
            const isUser = message.getAttribute('is_user') === 'true';
            const actions = document.createElement('div');
            actions.className = 'friend-message-actions';

            const copy = createMessageAction('fa-copy', '複製', 'copy');
            copy.addEventListener('click', async () => {
                const nativeCopy = message.querySelector('.mes_copy');
                if (nativeCopy && !isPreview) {
                    nativeCopy.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                    return;
                }
                try {
                    await navigator.clipboard.writeText(text.innerText.trim());
                } catch {
                    // Clipboard access may be unavailable in embedded previews.
                }
                dispatchPreviewMessageAction(message, 'copy');
            });
            actions.append(copy);

            if (isUser) {
                const edit = createMessageAction('fa-pen', '修改', 'edit');
                edit.addEventListener('click', () => {
                    const nativeEdit = message.querySelector('.mes_edit');
                    if (nativeEdit && !isPreview) {
                        nativeEdit.click();
                        return;
                    }
                    dispatchPreviewMessageAction(message, 'edit');
                });
                actions.append(edit);
            } else {
                const regenerate = createMessageAction('fa-rotate-right', '重新回覆', 'regenerate');
                regenerate.addEventListener('click', () => {
                    const nativeSwipe = message.querySelector('.swipe_right');
                    if (nativeSwipe && !isPreview) {
                        nativeSwipe.click();
                        return;
                    }
                    if (!isPreview) {
                        document.getElementById('option_regenerate')?.click();
                        return;
                    }
                    dispatchPreviewMessageAction(message, 'regenerate');
                });
                actions.append(regenerate);
            }

            const version = document.createElement('span');
            version.className = 'friend-message-version';
            const nativeCounter = message.querySelector('.swipes-counter');
            version.textContent = message.dataset.friendVersion || nativeCounter?.textContent?.trim() || '1 / 1';
            version.title = '所有回覆版本都會保留';
            actions.append(version);
            block.append(actions);
        });
    }

    function updateViewport() {
        const viewport = window.visualViewport;
        const height = viewport?.height || window.innerHeight;
        const keyboardIsOpen = Boolean(viewport && window.innerHeight - viewport.height > 140);
        document.documentElement.style.setProperty('--friend-viewport-height', `${Math.round(height)}px`);
        document.body.classList.toggle('keyboard-open', keyboardIsOpen);
    }

    function applyMode() {
        document.body.classList.toggle('friend-mobile-ui', mobileQuery.matches);
        document.body.classList.toggle('friend-desktop-ui', !mobileQuery.matches);
        if (!mobileQuery.matches) {
            closeTools();
        }
        updateViewport();
        updateContext();
    }

    function observeUiState() {
        const observer = new MutationObserver(() => {
            window.clearTimeout(contextTimer);
            contextTimer = window.setTimeout(() => {
                updateContext();
                enhanceMessageActions();
            }, 30);
        });

        const chat = document.getElementById('chat');
        const sendForm = document.getElementById('send_form');
        const stopButton = document.getElementById('mes_stop');
        const characterTitle = document.querySelector('#rm_button_selected_ch h2');

        if (chat) observer.observe(chat, { childList: true, subtree: false });
        if (sendForm) observer.observe(sendForm, { attributes: true, attributeFilter: ['class'] });
        if (stopButton) observer.observe(stopButton, { attributes: true, attributeFilter: ['class', 'style'] });
        if (characterTitle) observer.observe(characterTitle, { childList: true, characterData: true, subtree: true });

        document.getElementById('selected_chat_pole')?.addEventListener('change', updateContext);
    }

    function initialize() {
        createHeader();
        createDesktopSidebar();
        createDesktopContextbar();
        try {
            toggleDesktopSidebar(window.localStorage.getItem('friend-sidebar-collapsed') === 'true');
        } catch {
            toggleDesktopSidebar(false);
        }
        void loadRecentChats();
        labelSettingsTools();
        enhanceComposer();
        enhanceMessageActions();
        observeUiState();
        applyMode();

        mobileQuery.addEventListener?.('change', applyMode);
        window.visualViewport?.addEventListener('resize', () => {
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(updateViewport, 30);
        });
        window.addEventListener('resize', updateViewport);
        window.addEventListener('orientationchange', updateViewport);

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeTools();
                setMobileSidebar(false);
            }
        });

        document.addEventListener('pointerdown', (event) => {
            if (!document.body.classList.contains('friend-mobile-tools-open') && !document.body.classList.contains('friend-desktop-tools-open')) {
                return;
            }
            if (event.target.closest('#top-settings-holder, [data-friend-action="tools"], [data-friend-action="desktopTools"]')) {
                return;
            }
            closeTools();
        });

        document.getElementById('top-settings-holder')?.addEventListener('click', (event) => {
            if (event.target.closest('.drawer-toggle')) {
                closeTools();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
