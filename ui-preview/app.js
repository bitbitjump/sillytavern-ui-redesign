import { chatContextLimit, generationParameters, replyStyles, validateChatContext, validateGenerationSettings } from './generation-settings.mjs';

(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const shell = $('#app-shell');
  const panel = $('#utility-panel');
  const panelTitle = $('#panel-title');
  const panelEyebrow = $('#panel-eyebrow');
  const panelContent = $('#panel-content');
  const panelStatus = $('#panel-status');
  const toolPicker = $('#composer-tools');
  const toolToggle = $('#composer-tools-toggle');
  const accountMenu = $('#account-menu');
  const accountToggle = $('#account-toggle');
  const conversation = $('#conversation');
  const composer = $('#composer');
  const input = $('#message-input');
  const sendButton = $('#send-button');
  const chatStatus = $('#chat-status');
  const toast = $('#toast');
  const isNarrow = () => matchMedia('(max-width: 940px)').matches;
  const versions = new WeakMap();
  let toastTimer;
  let pinnedMenu;
  let pointerStartedOnBackdrop = false;
  let localModel;
  let generating = false;
  let activeChat;
  const hosted = document.body.hasAttribute('data-hosted');
  let hostedUi;
  let accountProfile = {};
  const defaultAppearance = { mode: 'night', color: '#d9a05b' };
  const appearanceKey = 'tavern-guest-appearance';
  let savedAppearance = defaultAppearance;
  function roomSettings() {
    return (hosted ? hostedUi?.getSettings() : activeChat?.settings) || {};
  }

  async function saveRoomSettings(form, readSettings) {
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    panelStatus.textContent = '';
    try {
      const patch = readSettings(new FormData(form));
      if (hosted) await hostedUi.saveSettings(patch);
      else Object.assign(activeChat.settings, patch);
      if (form.isConnected && panel.open) panelStatus.textContent = '已儲存到這個聊天室，下一則回覆會套用。';
    } catch (error) {
      if (form.isConnected && panel.open) panelStatus.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  function renderChatSettings() {
    panelContent.innerHTML = `
      <form class="generation-form" id="chat-settings-form">
        <p class="room-settings-note">設定只套用到這個聊天室。</p>
        <label class="generation-field">
          <span>世界觀</span>
          <textarea name="world" rows="4" maxlength="${chatContextLimit}" placeholder="故事背景、角色關係、世界規則"></textarea>
        </label>
        <label class="generation-field">
          <span>對話需求</span>
          <textarea name="instructions" rows="4" maxlength="${chatContextLimit}" placeholder="想完成的事、回覆方式、希望避免的內容"></textarea>
        </label>
        <label class="generation-field">
          <span>系統提示詞</span>
          <textarea name="systemPrompt" rows="5" maxlength="${chatContextLimit}" placeholder="例如：你是劇情編輯。保留人物原有個性，先指出矛盾，再提供兩種改法。"></textarea>
          <small>每次回覆前提供給模型的指令，可以留白。</small>
        </label>
        <div class="generation-actions"><button type="submit">儲存設定</button></div>
      </form>${panelData.settings[2]}`;
    const form = $('#chat-settings-form');
    const { world = '', instructions = '', systemPrompt = '' } = roomSettings().context || {};
    form.elements.namedItem('world').value = world;
    form.elements.namedItem('instructions').value = instructions;
    form.elements.namedItem('systemPrompt').value = systemPrompt;
    form.onsubmit = event => {
      event.preventDefault();
      return saveRoomSettings(form, fields => ({
        context: validateChatContext(Object.fromEntries(fields)),
      }));
    };
  }

  function renderGenerationSettings() {
    const options = Object.entries(replyStyles).map(([key, { label }]) =>
      `<option value="${key}">${label}</option>`).join('');
    const inputs = generationParameters.map(({ key, label, min, max, step, description }) => `
      <label class="generation-field">
        <span>${label}</span>
        <input name="${key}" type="number" min="${min}" max="${max}" step="${step}" placeholder="模型預設">
        <small>${description}</small>
      </label>`).join('');
    panelContent.innerHTML = `
      <form class="generation-form">
        <p class="room-settings-note">設定只套用到這個聊天室。</p>
        <label class="generation-field">
          <span>回覆語氣</span>
          <select name="style">${options}</select>
          <small>以提示詞引導回覆風格。</small>
        </label>
        <fieldset>
          <legend>生成參數</legend>
          <p>留白就沿用模型服務的預設值。只填模型支援的參數。</p>
          ${inputs}
        </fieldset>
        <div class="generation-actions">
          <button type="button" id="reset-generation">清空設定</button>
          <button type="submit">儲存設定</button>
        </div>
      </form>`;
    const form = $('.generation-form');
    const generation = roomSettings().generation || {};
    form.elements.namedItem('style').value = generation.style || 'default';
    for (const { key } of generationParameters) {
      form.elements.namedItem(key).value = generation[key] ?? '';
    }
    $('#reset-generation').onclick = () => {
      form.reset();
      panelStatus.textContent = '已清空欄位。按儲存設定套用。';
    };
    form.onsubmit = event => {
      event.preventDefault();
      return saveRoomSettings(form, fields => {
        const values = { style: fields.get('style') };
        for (const { key } of generationParameters) {
          const value = fields.get(key);
          if (value !== '') values[key] = Number(value);
        }
        const { style, parameters } = validateGenerationSettings(values);
        return { generation: { style, ...parameters } };
      });
    };
  }

  async function modelApi(path, body) {
    const response = await fetch(`/api/local-model${path}`, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '本機後端回應異常。');
    return data;
  }

  function startLocalChat() {
    if (generating) return;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-row';
    row.dataset.title = '新聊天';
    row.innerHTML = '<i class="fa-solid fa-comments" aria-hidden="true"></i><span>新聊天</span>';
    const chat = { row, messages: [], draft: '', settings: {} };
    row.addEventListener('click', () => {
      if (generating) return;
      switchLocalChat(chat);
      if (isNarrow()) closeFloatingSidebar();
    });
    $('#chat-history .chat-group').append(row);
    switchLocalChat(chat);
  }

  function switchLocalChat(chat) {
    if (activeChat) {
      activeChat.messages = $$('.message', conversation);
      activeChat.draft = input.value;
      activeChat.row.classList.remove('is-active');
      activeChat.messages.forEach(message => message.remove());
    }
    activeChat = chat;
    chat.row.classList.add('is-active');
    $('#chat-title').textContent = chat.row.dataset.title;
    conversation.append(...chat.messages);
    input.value = chat.draft;
    resizeInput();
    chatStatus.textContent = '';
    conversation.scrollTop = conversation.scrollHeight;
  }

  async function initLocalModel() {
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) return;
    try {
      const config = await modelApi('');
      if (!['mock', 'remote'].includes(config.mode) || typeof config.model !== 'string') return;
      localModel = config;
    } catch {
      return; // Standalone static preview.
    }
    $('#current-model').textContent = localModel.model;
    $('#connection-status span').textContent = localModel.mode === 'mock' ? '測試模式' : '模型模式';
    $('.conversation__intro p').textContent = localModel.mode === 'mock'
      ? '本機測試模式 · 回覆由測試後端產生'
      : '本機版 · 透過後端連接設定的模型';
    input.placeholder = '輸入訊息';
    $$('.message', conversation).forEach(message => message.remove());
    $('#chat-history').innerHTML = '<section class="chat-group"><h2>這次開啟的聊天</h2></section>';
    activeChat = undefined;
    startLocalChat();
  }

  function chatContext(before) {
    const messages = [];
    for (const article of $$('.message', conversation)) {
      if (article === before) break;
      messages.push({
        role: article.classList.contains('message--user') ? 'user' : 'assistant',
        content: messageText(article),
      });
    }
    return messages;
  }

  async function runLocalGeneration(messages, onReply) {
    if (generating) return;
    generating = true;
    input.readOnly = true;
    sendButton.disabled = true;
    chatStatus.textContent = '正在等待模型回覆…';
    try {
      const result = await modelApi('/chat', { messages, ...roomSettings() });
      onReply(result.content);
      chatStatus.textContent = '';
      return true;
    } catch (error) {
      chatStatus.textContent = error.message;
      return false;
    } finally {
      generating = false;
      input.readOnly = false;
      sendButton.disabled = false;
    }
  }

  const panelData = {
    roles: ['角色與人格', '選擇角色', `
      <section class="panel-section"><h3>這個聊天正在使用</h3><div class="panel-list">
        <button class="panel-card is-selected" type="button" data-select-role="書店寫作助手"><span class="panel-card__icon"><i class="fa-solid fa-feather-pointed"></i></span><span><strong>書店寫作助手</strong><small>安靜、細膩的敘事與角色對白</small></span><i class="fa-solid fa-check"></i></button>
      </div></section>
      <section class="panel-section"><h3>其他角色</h3><div class="panel-list">
        <button class="panel-card" type="button" data-select-role="奇幻世界主持人"><span class="panel-card__icon"><i class="fa-solid fa-dragon"></i></span><span><strong>奇幻世界主持人</strong><small>世界觀、冒險與多人角色扮演</small></span><i></i></button>
        <button class="panel-card" type="button" data-select-role="通用聊天助手"><span class="panel-card__icon"><i class="fa-solid fa-comment-dots"></i></span><span><strong>通用聊天助手</strong><small>不套用角色設定的日常問答</small></span><i></i></button>
      </div></section><p class="panel-note">角色卡的匯入、建立與進階設定會放在這個面板內，不會再另開一層蓋住畫面。</p>`],
    models: ['推理引擎', '模型與連線', `
      <section class="panel-section"><h3>目前模型</h3><div class="panel-list">
        <button class="panel-card is-selected" type="button" data-select-model="Tavern Story 7B"><span class="panel-card__icon"><i class="fa-solid fa-cube"></i></span><span><strong>Tavern Story 7B</strong><small>展示資料 · 尚未連接實際模型</small></span><i class="fa-solid fa-check"></i></button>
        <button class="panel-card" type="button" data-select-model="新增模型連線"><span class="panel-card__icon"><i class="fa-solid fa-plug"></i></span><span><strong>新增模型連線</strong><small>OpenAI 相容 API、Ollama 或自訂端點</small></span><i class="fa-solid fa-chevron-right"></i></button>
      </div></section><p class="panel-note">這個公開展示站不保存 API 金鑰。實際串接會放在本機／伺服器端設定，避免把私人連線資訊送到前端。</p>`],
    generation: ['這個聊天', '語氣與生成參數'],
    account: ['個人', '帳號設定'],
    appearance: ['個人', '外觀設定'],
    settings: ['這個聊天', '聊天設定', `
      <section class="panel-section"><h3>回覆偏好</h3>
        <div class="toggle-row"><span>串流顯示回覆</span><button class="switch is-on" type="button" aria-label="切換串流顯示"></button></div>
        <div class="toggle-row"><span>顯示回覆版本</span><button class="switch is-on" type="button" aria-label="切換回覆版本"></button></div>
        <div class="toggle-row"><span>自動儲存聊天</span><button class="switch is-on" type="button" aria-label="切換自動儲存"></button></div>
      </section><section class="panel-section"><h3>管理</h3><div class="panel-list"><button class="panel-card" type="button" data-tool="匯出聊天"><span class="panel-card__icon"><i class="fa-solid fa-file-export"></i></span><span><strong>匯出聊天</strong><small>下載完整對話與回覆版本</small></span><i class="fa-solid fa-chevron-right"></i></button></div></section>`]
  };

  function showToast(message) {
    if (panel.open) {
      panelStatus.textContent = message;
      return;
    }
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1800);
  }
  function openSidebar() {
    if (isNarrow()) shell.classList.add('sidebar-open'); else shell.classList.remove('sidebar-collapsed');
  }
  function closeSidebar() {
    closeAccountMenu();
    shell.classList.remove('sidebar-open');
    if (!isNarrow()) shell.classList.add('sidebar-collapsed');
  }
  function positionToolPicker() {
    const bounds = toolToggle.getBoundingClientRect();
    const width = Math.min(264, window.innerWidth - 24);
    toolPicker.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
    toolPicker.style.bottom = `${window.innerHeight - bounds.top + 8}px`;
    toolPicker.style.maxHeight = `${Math.max(0, bounds.top - 20)}px`;
  }

  function closeToolPicker() {
    if (!toolPicker.matches(':popover-open')) return;
    toolPicker.hidePopover();
    toolToggle.focus({ preventScroll: true });
  }

  toolPicker.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') positionToolPicker();
  });

  function closeAccountMenu() {
    if (!accountMenu.matches(':popover-open')) return;
    accountMenu.hidePopover();
    accountToggle.focus({ preventScroll: true });
  }

  function bindMenuPreview(trigger, menu) {
    const isOpen = () => menu.matches(':popover-open');
    const show = () => menu.showPopover({ source: trigger });
    let closeTimer;

    trigger.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(closeTimer);
      if (!pinnedMenu && !isOpen() && !panel.open) show();
    });
    menu.addEventListener('pointerenter', () => clearTimeout(closeTimer));

    function scheduleClose(event) {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (!isOpen() || pinnedMenu === menu) return;
      if (event.relatedTarget && (trigger.contains(event.relatedTarget) || menu.contains(event.relatedTarget))) return;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (pinnedMenu !== menu && isOpen() && !trigger.matches(':hover')
          && !menu.matches(':hover') && !menu.contains(document.activeElement)) menu.hidePopover();
      }, 220);
    }
    trigger.addEventListener('pointerleave', scheduleClose);
    menu.addEventListener('pointerleave', scheduleClose);
    menu.addEventListener('focusout', scheduleClose);

    trigger.addEventListener('click', event => {
      event.preventDefault();
      clearTimeout(closeTimer);
      if (pinnedMenu === menu && isOpen()) {
        menu.hidePopover();
        return;
      }
      if (!isOpen()) show();
      pinnedMenu = menu;
    });
    menu.addEventListener('beforetoggle', event => {
      if (event.newState === 'closed') {
        clearTimeout(closeTimer);
        if (pinnedMenu === menu) pinnedMenu = undefined;
      }
    });
  }

  bindMenuPreview(accountToggle, accountMenu);
  bindMenuPreview(toolToggle, toolPicker);

  function accountDisplayName({ email, displayName } = accountProfile) {
    const localName = email?.split('@')[0] || '訪客';
    return displayName || localName.charAt(0).toUpperCase() + localName.slice(1);
  }

  function drawAvatar(element, name, avatar) {
    element.textContent = Array.from(name)[0]?.toUpperCase() || '•';
    if (!avatar) return;
    const image = document.createElement('img');
    image.alt = '';
    image.src = avatar;
    element.replaceChildren(image);
  }

  function renderAccount(profile, actionLabel, actionUrl) {
    const justSignedIn = !accountProfile.email && profile.email;
    accountProfile = profile;
    if (profile.email) {
      const name = accountDisplayName();
      $('#account-name').textContent = name;
      drawAvatar($('.account-avatar', accountToggle), name, profile.avatar);
      savedAppearance = profile.appearance || defaultAppearance;
      applyAppearance(savedAppearance);
    } else {
      loadGuestAppearance();
    }
    if (actionLabel) {
      const action = $('#account-action');
      $('span', action).textContent = actionLabel;
      action.href = actionUrl;
      action.hidden = false;
    }
    if (justSignedIn && $('#account-profile-email')) renderAccountSettings();
  }

  async function resizeAvatar(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      throw new Error('請選擇 10 MB 以下的 JPG、PNG 或 WebP 圖片。');
    }
    const image = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 192;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#eee8df';
      context.fillRect(0, 0, 192, 192);
      const size = Math.min(image.width, image.height);
      context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 192, 192);
      return canvas.toDataURL('image/jpeg', 0.82);
    } finally {
      image.close();
    }
  }

  function renderAccountSettings() {
    panelContent.innerHTML = `
      <div class="toggle-row account-profile"><span>登入帳號</span><strong id="account-profile-email"></strong></div>
      <form class="generation-form personal-form" id="account-profile-form">
        <div class="profile-avatar-row">
          <span class="account-avatar profile-avatar" id="profile-avatar" aria-hidden="true"></span>
          <div class="profile-avatar-actions">
            <input type="file" accept="image/jpeg,image/png,image/webp" id="profile-file" hidden>
            <button type="button" id="choose-profile-avatar">更換頭貼</button>
            <button type="button" id="remove-profile-avatar">移除頭貼</button>
          </div>
        </div>
        <label class="generation-field"><span>顯示名稱</span><input name="displayName" type="text" maxlength="40" autocomplete="nickname"></label>
        <div class="generation-actions"><button type="submit">儲存帳號設定</button></div>
      </form>
      <p class="room-settings-note" id="profile-guest-note">登入後即可修改頭貼和顯示名稱。</p>`;
    $('#account-profile-email').textContent = accountProfile.email || '尚未登入';
    const form = $('#account-profile-form');
    form.hidden = !accountProfile.email;
    $('#profile-guest-note').hidden = !!accountProfile.email;
    if (form.hidden) return;
    const name = form.elements.namedItem('displayName');
    name.value = accountProfile.displayName || '';
    name.placeholder = accountDisplayName({ email: accountProfile.email });
    const fileInput = $('#profile-file');
    const choose = $('#choose-profile-avatar');
    const remove = $('#remove-profile-avatar');
    const submit = $('button[type="submit"]', form);
    let avatar = accountProfile.avatar ?? null;
    let upload = 0;
    function preview() {
      drawAvatar($('#profile-avatar', form), name.value.trim() || name.placeholder, avatar);
      remove.hidden = !avatar;
    }
    preview();
    name.oninput = preview;
    choose.onclick = () => fileInput.click();
    remove.onclick = () => {
      upload++;
      avatar = null;
      submit.disabled = false;
      panelStatus.textContent = '';
      preview();
    };
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const request = ++upload;
      fileInput.value = '';
      submit.disabled = true;
      panelStatus.textContent = '';
      try {
        const resized = await resizeAvatar(file);
        if (request !== upload || !form.isConnected || !panel.open) return;
        avatar = resized;
        preview();
      } catch (error) {
        if (request === upload && form.isConnected && panel.open) panelStatus.textContent = error.message || '無法讀取圖片。';
      } finally {
        if (request === upload) submit.disabled = false;
      }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (submit.disabled) return;
      for (const control of [submit, name, choose, remove]) control.disabled = true;
      panelStatus.textContent = '';
      try {
        renderAccount(await hostedUi.saveAccountPreferences({ displayName: name.value, avatar }));
        if (form.isConnected && panel.open) panelStatus.textContent = '已儲存帳號設定。';
      } catch (error) {
        if (form.isConnected && panel.open) panelStatus.textContent = error.message;
      } finally {
        for (const control of [submit, name, choose, remove]) control.disabled = false;
      }
    };
  }

  function applyAppearance({ mode, color }) {
    document.documentElement.dataset.appearance = mode;
    document.documentElement.style.setProperty('--appearance-color', color);
  }

  function loadGuestAppearance() {
    try {
      const appearance = JSON.parse(localStorage.getItem(appearanceKey));
      if (appearance && ['day', 'night', 'custom'].includes(appearance.mode) && /^#[0-9a-f]{6}$/i.test(appearance.color)) {
        savedAppearance = appearance;
      }
    } catch {
      // Use the default theme when browser storage is unavailable.
    }
    applyAppearance(savedAppearance);
  }

  function renderAppearanceSettings() {
    panelContent.innerHTML = `
      <form class="generation-form personal-form" id="appearance-form">
        <fieldset class="appearance-choices">
          <legend>配色模式</legend>
          <label><input type="radio" name="mode" value="day">白天</label>
          <label><input type="radio" name="mode" value="night">黑夜</label>
          <label><input type="radio" name="mode" value="custom">自訂</label>
        </fieldset>
        <label class="appearance-color" hidden><span>主色</span><input type="color" name="color"></label>
        <p class="room-settings-note">自訂沿用黑夜的明暗，只換色系。</p>
        <div class="generation-actions"><button type="submit">儲存外觀</button></div>
      </form>`;
    const form = $('#appearance-form');
    const color = form.elements.namedItem('color');
    const modes = form.elements.namedItem('mode');
    modes.value = savedAppearance.mode;
    color.value = savedAppearance.color;
    function preview() {
      $('.appearance-color', form).hidden = modes.value !== 'custom';
      applyAppearance({ mode: modes.value, color: color.value });
    }
    preview();
    form.oninput = preview;
    form.onsubmit = async event => {
      event.preventDefault();
      const appearance = { mode: modes.value, color: color.value };
      for (const control of form.elements) control.disabled = true;
      try {
        if (accountProfile.email) {
          renderAccount(await hostedUi.saveAccountPreferences({ appearance }));
        } else {
          savedAppearance = appearance;
          applyAppearance(savedAppearance);
          localStorage.setItem(appearanceKey, JSON.stringify(appearance));
        }
        if (form.isConnected && panel.open) panelStatus.textContent = '已儲存外觀。';
      } catch (error) {
        if (form.isConnected && panel.open) panelStatus.textContent = error.message || '無法儲存外觀。';
      } finally {
        for (const control of form.elements) control.disabled = false;
      }
    };
  }

  function openPanel(kind) {
    if (panel.open) return;
    const focusPrompt = kind === 'prompt';
    if (focusPrompt) kind = 'settings';
    const data = panelData[kind];
    if (!data) return;
    closeToolPicker();
    closeAccountMenu();
    panelEyebrow.textContent = data[0];
    if (kind === 'settings' || kind === 'generation') panelEyebrow.textContent = $('#chat-title').textContent;
    panelTitle.textContent = data[1];
    if (kind === 'generation') {
      renderGenerationSettings();
    } else if (kind === 'settings') {
      renderChatSettings();
    } else if (kind === 'account') {
      renderAccountSettings();
    } else if (kind === 'appearance') {
      renderAppearanceSettings();
    } else if (kind === 'models' && hostedUi) {
      hostedUi.modelPanel();
    } else if (kind === 'models' && localModel) {
      panelContent.innerHTML = `
        <p class="panel-note"><strong id="configured-model"></strong><br>
          模型連線由本機啟動設定管理。</p>
        <button class="panel-card" type="button" id="check-model">
          <span class="panel-card__icon"><i class="fa-solid fa-plug"></i></span>
          <span><strong>測試連線</strong><small>檢查端點和模型 ID</small></span>
        </button>`;
      $('#configured-model').textContent = localModel.model;
      const check = $('#check-model');
      check.addEventListener('click', async () => {
        check.disabled = true;
        panelStatus.textContent = '檢查中…';
        try {
          const result = await modelApi('/check', {});
          if (check.isConnected && panel.open) panelStatus.textContent = result.status;
        } catch (error) {
          if (check.isConnected && panel.open) panelStatus.textContent = error.message;
        } finally {
          check.disabled = false;
        }
      });
    } else {
      panelContent.innerHTML = data[2];
    }
    panelStatus.textContent = '';
    pointerStartedOnBackdrop = false;
    panel.showModal();
    panelContent.scrollTop = 0;
    if (focusPrompt) $('textarea[name="systemPrompt"]', panelContent).focus();
  }
  function closePanel() { panel.close(); }
  panel.addEventListener('close', () => {
    if ($('#appearance-form')) applyAppearance(savedAppearance);
  });
  function isBackdropPointer(event) {
    if (event.target !== panel) return false;
    const bounds = panel.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }

  panel.addEventListener('pointerdown', event => {
    pointerStartedOnBackdrop = event.button === 0 && isBackdropPointer(event);
  });
  panel.addEventListener('pointercancel', () => {
    pointerStartedOnBackdrop = false;
  });
  panel.addEventListener('click', event => {
    const shouldClose = pointerStartedOnBackdrop && isBackdropPointer(event);
    pointerStartedOnBackdrop = false;
    if (shouldClose) closePanel();
  });
  function closeFloatingSidebar() {
    closeAccountMenu();
    shell.classList.remove('sidebar-open');
  }
  function resizeInput() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
  function escapeHtml(value) { const el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
  function messageText(article) { return $('.message__body', article)?.innerText.trim() || ''; }

  async function copyMessage(article) {
    try { await navigator.clipboard.writeText(messageText(article)); showToast('已複製訊息'); }
    catch { showToast('瀏覽器未允許複製'); }
  }
  function editMessage(article) {
    if (generating || $('.message-editor', article)) return;
    const body = $('.message__body', article); const actions = $('.message-actions', article); const original = body.innerText.trim();
    body.hidden = true; actions.hidden = true;
    const editor = document.createElement('div');
    editor.innerHTML = '<textarea class="message-editor" aria-label="編輯訊息"></textarea><div class="edit-controls"><button class="cancel-edit" type="button">取消</button><button class="save-edit" type="button">儲存並送出</button></div>';
    $('.message-editor', editor).value = original; article.insertBefore(editor, actions); $('.message-editor', editor).focus();
    if (localModel) $('.save-edit', editor).textContent = '儲存修改';
    $('.cancel-edit', editor).onclick = () => { editor.remove(); body.hidden = false; actions.hidden = false; };
    $('.save-edit', editor).onclick = () => { const value = $('.message-editor', editor).value.trim(); if (!value) return; body.innerHTML = `<p>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`; editor.remove(); body.hidden = false; actions.hidden = false; showToast('已更新訊息，舊回覆仍保留'); };
  }
  function regenerate(article) {
    const content = $('.version-content', article); const list = versions.get(article) || [content.innerHTML];
    if (localModel) {
      runLocalGeneration(chatContext(article), reply => {
        list.push(`<p>${escapeHtml(reply).replace(/\n/g, '<br>')}</p>`);
        versions.set(article, list);
        article.dataset.version = String(list.length - 1);
        renderVersion(article);
      });
      return;
    }
    const options = [
      '<p>已記住。這一次，門上的鈴沒有立刻響。</p><p>周澈把藍傘靠在門邊，水珠沿著傘骨慢慢墜落。他看著林岑，像是在等一句遲了五年的話。林岑只把熱茶推過去，指尖在杯緣停了一下。</p><blockquote>「先坐吧，雨一時不會停。」</blockquote><p>於是周澈坐下，而雨替他們把沉默說完。</p>',
      '<p>書店裡仍留著舊紙張與雨水混在一起的氣味。</p><p>林岑沒有問他為什麼回來，只從櫃檯下拿出一條乾毛巾。周澈接過時笑得很輕，藍傘在腳邊滴出一圈小小的水痕。</p><blockquote>「你還留著那盞燈。」</blockquote><p>林岑望向窗邊：「怕有人找不到路。」</p>'
    ];
    list.push(options[(list.length - 1) % options.length]); versions.set(article, list); article.dataset.version = String(list.length - 1); renderVersion(article); showToast('已產生新版本，之前的回覆仍可切換');
  }
  function renderVersion(article) {
    const list = versions.get(article); if (!list) return;
    let index = Math.max(0, Math.min(Number(article.dataset.version || 0), list.length - 1)); article.dataset.version = String(index);
    $('.version-content', article).innerHTML = list[index]; const switcher = $('.version-switch', article); switcher.hidden = list.length < 2;
    $('.version-label', switcher).textContent = `${index + 1} / ${list.length}`; $('[data-version-nav="prev"]', switcher).disabled = index === 0; $('[data-version-nav="next"]', switcher).disabled = index === list.length - 1;
  }
  function addMessage(text, who, targetChat = activeChat) {
    const article = document.createElement('article'); article.className = `message message--${who}`;
    article.innerHTML = who === 'user'
      ? `<div class="message__body"><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></div><div class="message-actions"><button type="button" data-action="copy"><i class="fa-solid fa-copy"></i><span>複製</span></button><button type="button" data-action="edit"><i class="fa-solid fa-pen"></i><span>編輯</span></button></div>`
      : `<div class="message__identity"><div class="assistant-avatar assistant-avatar--small"><i class="fa-solid fa-feather-pointed"></i></div><div><strong>書店寫作助手</strong><small>剛剛</small></div></div><div class="message__body"><p>${escapeHtml(text)}</p></div><div class="message-actions"><button type="button" data-action="copy"><i class="fa-solid fa-copy"></i><span>複製</span></button></div>`;
    if (localModel && who === 'assistant') {
      const body = $('.message__body', article);
      body.classList.add('version-content');
      body.innerHTML = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
      $('.message__identity strong', article).textContent = localModel.model;
      $('.message-actions', article).insertAdjacentHTML('beforeend', `
        <button type="button" data-action="regenerate" title="重新回覆"><i class="fa-solid fa-rotate-right"></i><span>重新回覆</span></button>
        <div class="version-switch" hidden>
          <button type="button" data-version-nav="prev" aria-label="上一個版本">‹</button>
          <span class="version-label"></span>
          <button type="button" data-version-nav="next" aria-label="下一個版本">›</button>
        </div>`);
    }
    if (targetChat && targetChat !== activeChat) {
      targetChat.messages.push(article);
    } else {
      conversation.appendChild(article);
      conversation.scrollTop = conversation.scrollHeight;
    }
    return article;
  }

  $('#sidebar-open').onclick = openSidebar; $('#sidebar-close').onclick = closeSidebar; $('#panel-close').onclick = closePanel; $('#scrim').onclick = closeFloatingSidebar;
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-panel]'); if (opener) openPanel(opener.dataset.panel);
    const action = event.target.closest('[data-action]'); if (action) { const article = action.closest('.message'); if (action.dataset.action === 'copy') copyMessage(article); if (action.dataset.action === 'edit') editMessage(article); if (action.dataset.action === 'regenerate') regenerate(article); }
    const nav = event.target.closest('[data-version-nav]'); if (nav) { const article = nav.closest('.message'); article.dataset.version = String(Number(article.dataset.version || 0) + (nav.dataset.versionNav === 'prev' ? -1 : 1)); renderVersion(article); }
    const role = event.target.closest('[data-select-role]');
    if (role) {
      closePanel();
      showToast(`已切換為「${role.dataset.selectRole}」`);
    }
    const model = event.target.closest('[data-select-model]');
    if (model?.dataset.selectModel === '新增模型連線') {
      showToast('模型連線設定會在下一階段接上');
    } else if (model) {
      $('#current-model').textContent = model.dataset.selectModel;
      closePanel();
      showToast(`已選擇 ${model.dataset.selectModel}`);
    }
    const tool = event.target.closest('[data-tool]');
    if (tool) {
      closeToolPicker();
      showToast(`${tool.dataset.tool}（互動展示）`);
    }
    const toggle = event.target.closest('.switch'); if (toggle) toggle.classList.toggle('is-on');
  });
  if (!hosted) {
    for (const row of $$('.chat-row')) {
      const chat = { row, messages: [], draft: '', settings: {} };
      if (row.classList.contains('is-active')) activeChat = chat;
      row.onclick = event => {
        if (event.target.closest('.row-more')) { showToast('聊天選單：重新命名、匯出、刪除'); return; }
        if (activeChat !== chat) switchLocalChat(chat);
        if (isNarrow()) closeFloatingSidebar();
      };
    }
  }
  $('#new-chat').onclick = () => {
    if (hosted) return hostedUi?.newChat();
    if (generating) return;
    startLocalChat();
    if (isNarrow()) closeFloatingSidebar();
    input.focus();
    showToast('已建立新聊天');
  };
  $('#chat-search').oninput = event => { const query = event.target.value.trim().toLocaleLowerCase(); $$('.chat-row').forEach(row => { row.hidden = Boolean(query && !row.dataset.title.toLocaleLowerCase().includes(query)); }); $$('.chat-group').forEach(group => { group.hidden = !$$('.chat-row', group).some(row => !row.hidden); }); };
  composer.onsubmit = event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || generating) return;
    if (hosted) return hostedUi?.sendMessage(text);
    if (localModel) {
      const context = chatContext();
      const pending = addMessage(text, 'user');
      runLocalGeneration([...context, { role: 'user', content: text }], reply => {
        addMessage(reply, 'assistant');
        if (context.length === 0) {
          const title = text.slice(0, 28);
          activeChat.row.dataset.title = title;
          $('span', activeChat.row).textContent = title;
          $('#chat-title').textContent = title;
        }
        input.value = '';
        resizeInput();
      }).then(succeeded => {
        if (!succeeded) pending.remove();
      });
      return;
    }
    const target = activeChat;
    addMessage(text, 'user');
    input.value = '';
    resizeInput();
    setTimeout(() => addMessage('這是介面互動展示；模型串接完成後，回覆會從你的模型服務送回這裡。', 'assistant', target), 380);
  };
  input.oninput = resizeInput; input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.open
      && !toolPicker.matches(':popover-open') && !accountMenu.matches(':popover-open')) closeFloatingSidebar();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (!panel.open) $('#new-chat').click();
    }
  });
  addEventListener('resize', () => {
    if (!isNarrow()) shell.classList.remove('sidebar-open');
    if (toolPicker.matches(':popover-open')) positionToolPicker();
  });
  if (hosted) {
    import('./hosted/ui.mjs').then(({ createHostedUi }) => {
      hostedUi = createHostedUi({ addMessage, escapeHtml, resizeInput, openPanel,
        closeFloatingSidebar, isNarrow, renderAccount });
      return hostedUi.init();
    }).catch(() => { chatStatus.textContent = '網站聊天模組無法載入。'; });
  } else {
    loadGuestAppearance();
    initLocalModel();
  }
})();
