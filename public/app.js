(function () {
  const el = (id) => document.getElementById(id);

  const apiKeyInput = el('apiKey');
  const modelInput = el('model');
  const uploadBtn = el('uploadBtn');
  const zipInput = el('zipInput');
  const downloadBtn = el('downloadBtn');
  const newSessionBtn = el('newSessionBtn');
  const sessionLabel = el('sessionLabel');
  const topbarSub = el('topbarSub');
  const fileTree = el('fileTree');
  const messages = el('messages');
  const composer = el('composer');
  const input = el('input');
  const sendBtn = el('sendBtn');
  const fileModal = el('fileModal');
  const fileModalPath = el('fileModalPath');
  const fileModalContent = el('fileModalContent');
  const fileModalClose = el('fileModalClose');

  const sidebar = el('sidebar');
  const backdrop = el('backdrop');
  const openDrawer = el('openDrawer');
  const closeDrawer = el('closeDrawer');

  const plusBtn = el('plusBtn');
  const attachMenu = el('attachMenu');
  const attachUpload = el('attachUpload');
  const attachDownload = el('attachDownload');

  let sessionId = null;

  // ---- convenience field persistence (never workspace state) ----
  apiKeyInput.value = localStorage.getItem('gemini_agent_api_key') || '';
  modelInput.value = localStorage.getItem('gemini_agent_model') || 'gemini-2.5-flash';
  apiKeyInput.addEventListener('input', () => localStorage.setItem('gemini_agent_api_key', apiKeyInput.value));
  modelInput.addEventListener('input', () => localStorage.setItem('gemini_agent_model', modelInput.value));

  // ---- drawer (mobile sidebar) ----
  function showDrawer() {
    sidebar.classList.add('open');
    backdrop.classList.remove('hidden');
  }
  function hideDrawer() {
    sidebar.classList.remove('open');
    backdrop.classList.add('hidden');
  }
  openDrawer.addEventListener('click', showDrawer);
  closeDrawer.addEventListener('click', hideDrawer);
  backdrop.addEventListener('click', hideDrawer);

  // ---- attach ("+") menu ----
  function toggleAttachMenu(force) {
    const willShow = force !== undefined ? force : attachMenu.classList.contains('hidden');
    attachMenu.classList.toggle('hidden', !willShow);
  }
  plusBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleAttachMenu(); });
  document.addEventListener('click', (e) => {
    if (!attachMenu.contains(e.target) && e.target !== plusBtn) toggleAttachMenu(false);
  });

  // ---- auto-grow textarea ----
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  function addMessage(text, cls) {
    const div = document.createElement('div');
    div.className = `msg ${cls}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function addDownloadChip() {
    if (!sessionId) return;
    const chip = document.createElement('div');
    chip.className = 'download-chip';
    chip.innerHTML = `
      <div class="icon">📦</div>
      <div class="info"><strong>workspace.zip</strong><span>Current workspace, zipped</span></div>
      <button type="button">Download</button>
    `;
    chip.querySelector('button').addEventListener('click', () => {
      window.location.href = `/api/download/${sessionId}`;
    });
    messages.appendChild(chip);
    messages.scrollTop = messages.scrollHeight;
  }

  function addToolLog(toolLog) {
    if (!toolLog || !toolLog.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'tool-log';
    for (const t of toolLog) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${t.name}(${JSON.stringify(t.args)})`;
      const pre = document.createElement('pre');
      pre.textContent = t.output;
      details.appendChild(summary);
      details.appendChild(pre);
      wrap.appendChild(details);
    }
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function newSession() {
    const data = await api('/api/session', { method: 'POST' });
    sessionId = data.sessionId;
    sessionLabel.textContent = `session: ${sessionId}`;
    topbarSub.textContent = `session ${sessionId.slice(0, 8)}…`;
    renderFiles([]);
  }

  function renderFiles(files) {
    fileTree.innerHTML = '';
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Empty workspace. Upload a zip or ask the agent to create files.';
      fileTree.appendChild(empty);
      return;
    }
    for (const f of files) {
      const isDir = f.endsWith('/');
      const row = document.createElement('div');
      row.className = 'entry' + (isDir ? ' dir' : '');
      row.textContent = f;
      if (!isDir) {
        row.addEventListener('click', () => openFilePreview(f.replace(/ \(\d+b\)$/, '')));
      }
      fileTree.appendChild(row);
    }
  }

  async function openFilePreview(relPath) {
    try {
      const data = await api(`/api/file/${sessionId}?path=${encodeURIComponent(relPath)}`);
      fileModalPath.textContent = data.path;
      fileModalContent.textContent = data.content;
      fileModal.classList.remove('hidden');
    } catch (e) {
      addMessage(`Could not open ${relPath}: ${e.message}`, 'error');
    }
  }

  fileModalClose.addEventListener('click', () => fileModal.classList.add('hidden'));
  fileModal.addEventListener('click', (e) => { if (e.target === fileModal) fileModal.classList.add('hidden'); });

  async function doUpload(file) {
    if (!file || !sessionId) return;
    const fd = new FormData();
    fd.append('zip', file);
    fd.append('sessionId', sessionId);
    try {
      const data = await api('/api/upload', { method: 'POST', body: fd });
      renderFiles(data.files || []);
      addMessage(`📦 Uploaded and extracted ${file.name}.`, 'system');
    } catch (e) {
      addMessage(`Upload failed: ${e.message}`, 'error');
    }
  }

  uploadBtn.addEventListener('click', () => zipInput.click());
  attachUpload.addEventListener('click', () => { toggleAttachMenu(false); zipInput.click(); });
  zipInput.addEventListener('change', async () => {
    await doUpload(zipInput.files[0]);
    zipInput.value = '';
  });

  function doDownload() {
    if (!sessionId) return;
    window.location.href = `/api/download/${sessionId}`;
  }
  downloadBtn.addEventListener('click', doDownload);
  attachDownload.addEventListener('click', () => { toggleAttachMenu(false); doDownload(); });

  newSessionBtn.addEventListener('click', async () => {
    if (!confirm('Start a new session? This clears the current workspace and chat.')) return;
    messages.innerHTML = '';
    addMessage('New session started.', 'system');
    hideDrawer();
    await newSession();
  });

  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (!apiKeyInput.value.trim()) {
      addMessage('Enter your Gemini API key in the menu (☰) first.', 'error');
      return;
    }
    if (!modelInput.value.trim()) {
      addMessage('Enter a model id in the menu (☰) first, e.g. gemini-2.5-flash.', 'error');
      return;
    }
    if (!sessionId) await newSession();

    addMessage(text, 'user');
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    input.disabled = true;

    const thinking = addMessage('Working…', 'agent');

    try {
      const data = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          apiKey: apiKeyInput.value.trim(),
          model: modelInput.value.trim(),
          message: text
        })
      });
      thinking.remove();
      addToolLog(data.toolLog);
      addMessage(data.reply, 'agent');
      renderFiles(data.files || []);
      if (data.files && data.files.length) addDownloadChip();
    } catch (e) {
      thinking.remove();
      addMessage(`Error: ${e.message}`, 'error');
    } finally {
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  newSession().catch((e) => addMessage(`Could not start session: ${e.message}`, 'error'));
})();
