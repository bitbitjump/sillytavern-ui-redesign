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
  const conversation = $('#conversation');
  const composer = $('#composer');
  const input = $('#message-input');
  const toast = $('#toast');
  const isNarrow = () => matchMedia('(max-width: 940px)').matches;
  const versions = new WeakMap();
  let toastTimer;
  let pointerStartedOnBackdrop = false;

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
    tools: ['上下文與附件', '工具', `
      <section class="panel-section"><h3>加入聊天</h3><div class="panel-list">
        <button class="panel-card" type="button" data-tool="從電腦選擇檔案"><span class="panel-card__icon"><i class="fa-solid fa-paperclip"></i></span><span><strong>附加檔案</strong><small>PDF、文字、圖片與角色卡</small></span><i class="fa-solid fa-chevron-right"></i></button>
        <button class="panel-card" type="button" data-tool="開啟世界資訊"><span class="panel-card__icon"><i class="fa-solid fa-book-atlas"></i></span><span><strong>世界資訊</strong><small>管理故事設定、地點與人物知識</small></span><i class="fa-solid fa-chevron-right"></i></button>
        <button class="panel-card" type="button" data-tool="開啟提示詞庫"><span class="panel-card__icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span><span><strong>提示詞與預設</strong><small>套用常用指令與生成參數</small></span><i class="fa-solid fa-chevron-right"></i></button>
      </div></section>`],
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
    shell.classList.remove('sidebar-open');
    if (!isNarrow()) shell.classList.add('sidebar-collapsed');
  }
  function openPanel(kind) {
    if (panel.open) return;
    const data = panelData[kind] || panelData.tools;
    panelEyebrow.textContent = data[0];
    panelTitle.textContent = data[1];
    panelContent.innerHTML = data[2];
    panelStatus.textContent = '';
    pointerStartedOnBackdrop = false;
    panel.showModal();
    panelContent.scrollTop = 0;
  }
  function closePanel() { panel.close(); }
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
  function closeFloatingSidebar() { shell.classList.remove('sidebar-open'); }
  function resizeInput() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
  function escapeHtml(value) { const el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
  function messageText(article) { return $('.message__body', article)?.innerText.trim() || ''; }

  async function copyMessage(article) {
    try { await navigator.clipboard.writeText(messageText(article)); showToast('已複製訊息'); }
    catch { showToast('瀏覽器未允許複製'); }
  }
  function editMessage(article) {
    if ($('.message-editor', article)) return;
    const body = $('.message__body', article); const actions = $('.message-actions', article); const original = body.innerText.trim();
    body.hidden = true; actions.hidden = true;
    const editor = document.createElement('div');
    editor.innerHTML = '<textarea class="message-editor" aria-label="編輯訊息"></textarea><div class="edit-controls"><button class="cancel-edit" type="button">取消</button><button class="save-edit" type="button">儲存並送出</button></div>';
    $('.message-editor', editor).value = original; article.insertBefore(editor, actions); $('.message-editor', editor).focus();
    $('.cancel-edit', editor).onclick = () => { editor.remove(); body.hidden = false; actions.hidden = false; };
    $('.save-edit', editor).onclick = () => { const value = $('.message-editor', editor).value.trim(); if (!value) return; body.innerHTML = `<p>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`; editor.remove(); body.hidden = false; actions.hidden = false; showToast('已更新訊息，舊回覆仍保留'); };
  }
  function regenerate(article) {
    const content = $('.version-content', article); const list = versions.get(article) || [content.innerHTML];
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
  function addMessage(text, who) {
    const article = document.createElement('article'); article.className = `message message--${who}`;
    article.innerHTML = who === 'user'
      ? `<div class="message__body"><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></div><div class="message-actions"><button type="button" data-action="copy"><i class="fa-solid fa-copy"></i><span>複製</span></button><button type="button" data-action="edit"><i class="fa-solid fa-pen"></i><span>編輯</span></button></div>`
      : `<div class="message__identity"><div class="assistant-avatar assistant-avatar--small"><i class="fa-solid fa-feather-pointed"></i></div><div><strong>書店寫作助手</strong><small>剛剛</small></div></div><div class="message__body"><p>${escapeHtml(text)}</p></div><div class="message-actions"><button type="button" data-action="copy"><i class="fa-solid fa-copy"></i><span>複製</span></button></div>`;
    conversation.appendChild(article); conversation.scrollTop = conversation.scrollHeight; return article;
  }

  $('#sidebar-open').onclick = openSidebar; $('#sidebar-close').onclick = closeSidebar; $('#panel-close').onclick = closePanel; $('#attach-button').onclick = () => openPanel('tools'); $('#scrim').onclick = closeFloatingSidebar;
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
    const tool = event.target.closest('[data-tool]'); if (tool) showToast(`${tool.dataset.tool}（互動展示）`);
    const toggle = event.target.closest('.switch'); if (toggle) toggle.classList.toggle('is-on');
  });
  $$('.chat-row').forEach(row => row.onclick = event => {
    if (event.target.closest('.row-more')) { showToast('聊天選單：重新命名、匯出、刪除'); return; }
    $$('.chat-row').forEach(item => item.classList.remove('is-active')); row.classList.add('is-active'); $('#chat-title').textContent = row.dataset.title;
    if (isNarrow()) closeFloatingSidebar(); showToast(`已切換到「${row.dataset.title}」`);
  });
  $('#new-chat').onclick = () => { $$('.chat-row').forEach(item => item.classList.remove('is-active')); $('#chat-title').textContent = '新聊天'; if (isNarrow()) closeFloatingSidebar(); input.focus(); showToast('已建立新聊天'); };
  $('#chat-search').oninput = event => { const query = event.target.value.trim().toLocaleLowerCase(); $$('.chat-row').forEach(row => { row.hidden = Boolean(query && !row.dataset.title.toLocaleLowerCase().includes(query)); }); $$('.chat-group').forEach(group => { group.hidden = !$$('.chat-row', group).some(row => !row.hidden); }); };
  composer.onsubmit = event => { event.preventDefault(); const text = input.value.trim(); if (!text) return; addMessage(text, 'user'); input.value = ''; resizeInput(); setTimeout(() => addMessage('這是介面互動展示；模型串接完成後，回覆會從你的模型服務送回這裡。', 'assistant'), 380); };
  input.oninput = resizeInput; input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.open) closeFloatingSidebar();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (!panel.open) $('#new-chat').click();
    }
  });
  addEventListener('resize', () => { if (!isNarrow()) shell.classList.remove('sidebar-open'); });
})();
