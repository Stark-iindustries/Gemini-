(function () {
  const el = (id) => document.getElementById(id);

  const apiKeyInput = el('apiKey');
  const modelSelect = el('model');
  const uploadBtn = el('uploadBtn');
  const zipInput = el('zipInput');
  const downloadBtn = el('downloadBtn');
  const newSessionBtn = el('newSessionBtn');
  const sessionLabel = el('sessionLabel');
  const fileTree = el('fileTree');
  const messages = el('messages');
  const composer = el('composer');
  const input = el('input');
  const sendBtn = el('sendBtn');
  const fileModal = el('fileModal');
  const fileModalPath = el('fileModalPath');
  const fileModalContent = el('fileModalContent');
  const fileModalClose = el('fileModalClose');

  let sessionId = null;

  // Restore convenience fields (never workspace state) from localStorage.
  apiKeyInput.value = localStorage.getItem('gemini_agent_api_key') || '';
  modelSelect.value = localStorage.getItem('gemini_agent_model') || modelSelect.value;
  apiKeyInput.addEventListener('input', () => localStorage.setItem('gemini_agent_api_key', apiKeyInput.value));
  modelSelect.addEventListener('change', () => localStorage.setItem('gemini_agent_model', modelSelect.value));

  function addMessage(text, cls) {
    const div = document.createElement('div');
    div.className = `msg ${cls}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
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
    renderFiles([]);
  }

  async function refreshFiles() {
    if (!sessionId) return;
    try {
      const data = await api(`/api/files/${sessionId}`);
      renderFiles(data.files || []);
    } catch (e) {
      // ignore transient errors while refreshing
    }
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

  uploadBtn.addEventListener('click', () => zipInput.click());
  zipInput.addEventListener('change', async () => {
    const file = zipInput.files[0];
    if (!file || !sessionId) return;
    const fd = new FormData();
    fd.append('zip', file);
    fd.append('sessionId', sessionId);
    uploadBtn.disabled = true;
    try {
      const data = await api('/api/upload', { method: 'POST', body: fd });
      renderFiles(data.files || []);
      addMessage(`Uploaded and extracted ${file.name}.`, 'system');
    } catch (e) {
      addMessage(`Upload failed: ${e.message}`, 'error');
    } finally {
      uploadBtn.disabled = false;
      zipInput.value = '';
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!sessionId) return;
    window.location.href = `/api/download/${sessionId}`;
  });

  newSessionBtn.addEventListener('click', async () => {
    if (!confirm('Start a new session? This clears the current workspace and chat.')) return;
    messages.innerHTML = '';
    addMessage('New session started.', 'system');
    await newSession();
  });

  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (!apiKeyInput.value.trim()) {
      addMessage('Enter your Gemini API key in the sidebar first.', 'error');
      return;
    }
    if (!sessionId) await newSession();

    addMessage(text, 'user');
    input.value = '';
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
          model: modelSelect.value,
          message: text
        })
      });
      thinking.remove();
      addToolLog(data.toolLog);
      addMessage(data.reply, 'agent');
      renderFiles(data.files || []);
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
