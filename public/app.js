(function () {
  const el = (id) => document.getElementById(id);

  const apiKeyInput = el('apiKey');
  const modelSelect = el('model');
  const refreshModelsBtn = el('refreshModels');
  const modelHint = el('modelHint');
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

  const terminalToggle = el('terminalToggle');
  const terminalPanel = el('terminalPanel');
  const terminalClose = el('terminalClose');
  const terminalOutput = el('terminalOutput');

  let sessionId = null;

  // ---------------------------------------------------------------------
  // Markdown -> safe HTML (bold, italic, inline/code blocks, links, lists)
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderMarkdown(raw) {
    const codeBlocks = [];
    let text = String(raw).replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (m, code) => {
      codeBlocks.push(code.replace(/\n$/, ''));
      return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
    });

    text = escapeHtml(text);

    text = text.replace(/`([^`\n]+)`/g, '<span class="md-inline-code">$1</span>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    text = text.replace(/(^|[^\w])_([^_\n]+)_([^\w]|$)/g, '$1<em>$2</em>$3');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    text = text.replace(/(^|\n)[-*] (.+)/g, '$1• $2');
    text = text.replace(/\n/g, '<br>');

    text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (m, i) => `<div class="md-code-block">${escapeHtml(codeBlocks[i])}</div>`);

    return text;
  }

  // ---------------------------------------------------------------------
  // convenience field persistence
  // ---------------------------------------------------------------------
  apiKeyInput.value = localStorage.getItem('gemini_agent_api_key') || '';
  const savedModel = localStorage.getItem('gemini_agent_model') || '';

  function showTerminal() { terminalPanel.classList.remove('hidden'); }
  function hideTerminal() { terminalPanel.classList.add('hidden'); }
  terminalToggle.addEventListener('click', () => terminalPanel.classList.toggle('hidden'));
  terminalClose.addEventListener('click', hideTerminal);

  function terminalWrite(text) {
    terminalOutput.textContent += text;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function waitForAgentTerminal() {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (window.AgentTerminal) return resolve(window.AgentTerminal);
        if (Date.now() - start > 15000) return reject(new Error('The in-browser terminal script did not load in time.'));
        setTimeout(check, 100);
      })();
    });
  }

  // ---------------------------------------------------------------------
  // Model dropdown: fetched live from the API key's /api/models
  // ---------------------------------------------------------------------
  async function loadModels() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      modelSelect.innerHTML = '<option value="">Enter API key to load models…</option>';
      modelSelect.disabled = true;
      modelHint.textContent = "Your key's available models load automatically.";
      return;
    }
    refreshModelsBtn.classList.add('spinning');
    modelSelect.disabled = true;
    modelHint.textContent = 'Loading models…';
    try {
      const res = await fetch(`/api/models?apiKey=${encodeURIComponent(apiKey)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const models = data.models || [];
      if (!models.length) {
        modelSelect.innerHTML = '<option value="">No usable models found for this key</option>';
        modelHint.textContent = 'This key returned no models that support generateContent.';
        return;
      }
      modelSelect.innerHTML = models.map(m => `<option value="${m.id}">${m.displayName} (${m.id})</option>`).join('');
      modelSelect.disabled = false;
      const toSelect = (savedModel && models.some(m => m.id === savedModel)) ? savedModel : models[0].id;
      modelSelect.value = toSelect;
      localStorage.setItem('gemini_agent_model', modelSelect.value);
      modelHint.textContent = `Loaded ${models.length} model${models.length === 1 ? '' : 's'} for this key.`;
    } catch (e) {
      modelSelect.innerHTML = '<option value="">Could not load models</option>';
      modelHint.textContent = `Error: ${e.message}`;
    } finally {
      refreshModelsBtn.classList.remove('spinning');
    }
  }

  let apiKeyDebounce = null;
  apiKeyInput.addEventListener('input', () => {
    localStorage.setItem('gemini_agent_api_key', apiKeyInput.value);
    clearTimeout(apiKeyDebounce);
    apiKeyDebounce = setTimeout(loadModels, 700);
  });
  modelSelect.addEventListener('change', () => localStorage.setItem('gemini_agent_model', modelSelect.value));
  refreshModelsBtn.addEventListener('click', loadModels);

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
    div.innerHTML = renderMarkdown(text);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  // ---- live status bubble ("Thinking…", "Searching the web…", ...) ----
  let statusEl = null;
  function setStatus(label) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'msg status';
      statusEl.innerHTML = '<span class="spinner"></span><span class="label"></span>';
      messages.appendChild(statusEl);
    }
    statusEl.querySelector('.label').textContent = label;
    messages.scrollTop = messages.scrollHeight;
  }
  function clearStatus() {
    if (statusEl) { statusEl.remove(); statusEl = null; }
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

  function addToolLogEntry(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'tool-log';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${entry.name}(${JSON.stringify(entry.args)})`;
    const pre = document.createElement('pre');
    pre.textContent = entry.output;
    details.appendChild(summary);
    details.appendChild(pre);
    wrap.appendChild(details);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  function addCommandBubble(command) {
    const div = document.createElement('div');
    div.className = 'msg agent';
    div.textContent = `⌨️ Running: ${command}`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function toolLabel(phase, name, args) {
    const labels = {
      list_files: ['📁 Listing files…', `📁 Listed ${args && args.path ? args.path : 'workspace'}`],
      read_file: [`📄 Reading ${args && args.path}…`, `📄 Read ${args && args.path}`],
      write_file: [`✍️ Writing ${args && args.path}…`, `✍️ Wrote ${args && args.path}`],
      delete_file: [`🗑️ Deleting ${args && args.path}…`, `🗑️ Deleted ${args && args.path}`],
      make_directory: [`📁 Creating folder ${args && args.path}…`, `📁 Created ${args && args.path}`],
      search_web: [`🔍 Searching the web for “${args && args.query}”…`, `🔍 Searched: ${args && args.query}`]
    };
    const pair = labels[name] || [`⚙️ Running ${name}…`, `⚙️ Ran ${name}`];
    return phase === 'start' ? pair[0] : pair[1];
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Parses a fetch POST response as a stream of "data: {...}\n\n" SSE events.
  async function streamPost(url, body, onEvent) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let errMsg = `Request failed (${res.status})`;
      try { const data = await res.json(); if (data.error) errMsg = data.error; } catch (e) { /* not json */ }
      throw new Error(errMsg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) {
          try { onEvent(JSON.parse(line.slice(6))); } catch (e) { /* ignore malformed event */ }
        }
      }
    }
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

  // ---------------------------------------------------------------------
  // Drives the agent through its streamed steps, handling run_command
  // pauses by executing them in the browser's WebContainer terminal.
  // ---------------------------------------------------------------------
  async function runTurn(url, body) {
    let pendingCommand = null;
    let finalFiles = null;
    let sawText = false;

    await streamPost(url, body, (event) => {
      switch (event.type) {
        case 'thinking':
          setStatus('🤔 Thinking…');
          break;
        case 'thought':
          clearStatus();
          addMessage(event.text, 'thought');
          break;
        case 'text':
          clearStatus();
          addMessage(event.text, 'agent');
          sawText = true;
          break;
        case 'tool_start':
          setStatus(toolLabel('start', event.name, event.args));
          break;
        case 'tool_end':
          clearStatus();
          addToolLogEntry({ name: event.name, args: event.args, output: event.output });
          break;
        case 'run_command':
          clearStatus();
          pendingCommand = event.command;
          break;
        case 'done':
          clearStatus();
          finalFiles = event.files || [];
          if (!sawText && event.reply) addMessage(event.reply, 'agent');
          break;
        case 'error':
          clearStatus();
          addMessage(`Error: ${event.message}`, 'error');
          break;
      }
    });

    if (pendingCommand) {
      const apiKey = apiKeyInput.value.trim();
      const model = modelSelect.value;
      const bubble = addCommandBubble(pendingCommand);
      showTerminal();
      let output, exitCode;
      try {
        const terminal = await waitForAgentTerminal();
        if (!terminal.supported()) {
          throw new Error("Your browser can't run the in-browser terminal here (needs SharedArrayBuffer / cross-origin isolation).");
        }
        terminal.setOutputHandler(terminalWrite);
        const res = await terminal.runCommand(sessionId, pendingCommand);
        output = res.output;
        exitCode = res.exitCode;
        bubble.textContent = `⌨️ Ran: ${pendingCommand} (exit ${exitCode})`;
      } catch (e) {
        output = `Error: ${e.message}`;
        exitCode = -1;
        bubble.textContent = `⌨️ Failed: ${pendingCommand}`;
        terminalWrite(`\n${output}\n`);
      }
      return runTurn('/api/chat/command-result', { sessionId, apiKey, model, output, exitCode });
    }

    if (finalFiles) {
      renderFiles(finalFiles);
      if (finalFiles.length) addDownloadChip();
    }
  }

  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value;
    if (!apiKey) {
      addMessage('Enter your Gemini API key in the menu (☰) first.', 'error');
      return;
    }
    if (!model) {
      addMessage('Pick a model in the menu (☰) first.', 'error');
      return;
    }
    if (!sessionId) await newSession();

    addMessage(text, 'user');
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    input.disabled = true;

    try {
      await runTurn('/api/chat', { sessionId, apiKey, model, message: text });
    } catch (e) {
      clearStatus();
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
  if (apiKeyInput.value.trim()) loadModels();
})();
