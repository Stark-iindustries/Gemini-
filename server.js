const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Workspace / session management
// ---------------------------------------------------------------------------
const WORKSPACES_ROOT = path.join(__dirname, 'workspaces');
fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });

// sessionId -> array of Gemini "Content" objects (chat history)
const sessions = new Map();

function getWorkspaceDir(sessionId) {
  if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  return path.join(WORKSPACES_ROOT, sessionId);
}

function requireWorkspace(sessionId) {
  const dir = getWorkspaceDir(sessionId);
  if (!fs.existsSync(dir)) {
    const err = new Error('Unknown or expired session. Start a new session.');
    err.statusCode = 404;
    throw err;
  }
  return dir;
}

// Resolve a path the model gives us, and make sure it can never escape the
// workspace directory (basic zip-slip / path-traversal protection).
function safeResolve(base, relPath) {
  const target = path.resolve(base, relPath || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path "${relPath}" escapes the workspace and is not allowed.`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// File tools the agent can call
// ---------------------------------------------------------------------------
function listFiles(base, relPath, maxEntries = 500) {
  const start = safeResolve(base, relPath || '.');
  if (!fs.existsSync(start)) return [];
  const results = [];
  function walk(dir) {
    if (results.length >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (results.length >= maxEntries) return;
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        results.push(rel + '/');
        walk(full);
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (e) { /* ignore */ }
        results.push(`${rel} (${size}b)`);
      }
    }
  }
  const stat = fs.statSync(start);
  if (stat.isDirectory()) {
    walk(start);
  } else {
    results.push(path.relative(base, start).split(path.sep).join('/'));
  }
  return results;
}

function readFileTool(base, relPath) {
  const target = safeResolve(base, relPath);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    throw new Error(`"${relPath}" is a directory. Use list_files instead.`);
  }
  const MAX_BYTES = 200 * 1024;
  const buf = fs.readFileSync(target);
  const truncated = buf.length > MAX_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_BYTES) : buf;
  // crude binary check: presence of null bytes
  if (slice.includes(0)) {
    return `[Binary file, ${buf.length} bytes - not shown as text]`;
  }
  const text = slice.toString('utf8');
  return truncated
    ? `[File truncated to first ${MAX_BYTES} bytes of ${buf.length} total]\n${text}`
    : text;
}

function writeFileTool(base, relPath, content) {
  const target = safeResolve(base, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content === undefined || content === null ? '' : content, 'utf8');
  return `Wrote ${Buffer.byteLength(String(content || ''), 'utf8')} bytes to ${relPath}`;
}

function deleteFileTool(base, relPath) {
  const target = safeResolve(base, relPath);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
    return `Deleted directory ${relPath}`;
  }
  fs.unlinkSync(target);
  return `Deleted file ${relPath}`;
}

function makeDirTool(base, relPath) {
  const target = safeResolve(base, relPath);
  fs.mkdirSync(target, { recursive: true });
  return `Created directory ${relPath}`;
}

async function searchWeb(apiKey, model, query) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: `Search the web and give a concise, current, well-sourced answer to: ${query}` }] }],
    tools: [{ google_search: {} }]
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data && data.error && data.error.message ? data.error.message : `Search request failed (${res.status})`);
  }
  const cand = data.candidates && data.candidates[0];
  const text = (cand && cand.content && cand.content.parts || [])
    .map(p => p.text).filter(Boolean).join('\n') || '(no answer text returned)';
  const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const sources = chunks.map(c => c.web && c.web.uri).filter(Boolean);
  let out = text;
  if (sources.length) {
    out += '\n\nSources:\n' + sources.map(s => `- ${s}`).join('\n');
  }
  return out;
}

const TOOL_IMPLS = {
  list_files: (base, args) => listFiles(base, args.path).join('\n') || '(empty directory)',
  read_file: (base, args) => readFileTool(base, args.path),
  write_file: (base, args) => writeFileTool(base, args.path, args.content),
  delete_file: (base, args) => deleteFileTool(base, args.path),
  make_directory: (base, args) => makeDirTool(base, args.path)
};

// ---------------------------------------------------------------------------
// Gemini agent
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a coding agent operating on a virtual file workspace through tool calls.
You have these tools: list_files, read_file, write_file, delete_file, make_directory, search_web, and run_command.

run_command gives you a real, sandboxed Node.js terminal (with network access) that executes inside the user's
own browser tab. It is slower than the file tools (the browser has to actually run it), so only use it for things
that genuinely need a real process: installing dependencies ("npm install"), running scripts ("node index.js",
"npm test", "npm run build"), or anything else that isn't just editing a file. Use write_file/read_file/etc. for
plain file edits - don't shell out to "cat" or "echo >" just to read or write a file.

Guidelines:
- Only use your tools when the task actually needs them (e.g. working with files, code, or the workspace). For greetings or general chat, just reply normally without calling list_files or any other tool.
- When you do need to touch the workspace, use list_files first to understand the current structure before making assumptions about it.
- Before running commands, make sure relevant files already exist (write them first with write_file), since run_command operates on whatever is currently in the workspace.
- Use relative paths (e.g. "src/index.js"), never absolute paths, and never try to use "..".
- When asked to write code, actually call write_file to persist it in the workspace rather than only showing it in chat, unless the user explicitly just wants to see a snippet.
- Prefer making several small, correct edits over one huge rewrite when modifying existing files.
- Use search_web whenever you need current information, documentation, package versions, or anything you are not fully sure about.
- Be concise in your final reply to the user: summarize what you changed and why, don't repeat entire file contents unless asked.
- The user can download the whole workspace as a zip at any time from the UI, so you don't need to output full file contents just so they can copy them.`;

const TOOLS_DECL = [{
  functionDeclarations: [
    {
      name: 'list_files',
      description: 'List files and directories in the workspace, optionally under a subdirectory. Directories are suffixed with "/".',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Relative directory path. Defaults to the workspace root (".").' }
        }
      }
    },
    {
      name: 'read_file',
      description: 'Read the text content of a single file in the workspace.',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Relative file path to read.' }
        },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing one with the given text content. Parent directories are created automatically.',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Relative file path to write.' },
          content: { type: 'STRING', description: 'Full text content to write to the file.' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'delete_file',
      description: 'Delete a file, or recursively delete a directory, in the workspace.',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Relative path of the file or directory to delete.' }
        },
        required: ['path']
      }
    },
    {
      name: 'make_directory',
      description: 'Create a directory (and any missing parent directories) in the workspace.',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Relative directory path to create.' }
        },
        required: ['path']
      }
    },
    {
      name: 'search_web',
      description: 'Search the web for current information (docs, versions, news, anything outside training knowledge) and return a summarized, sourced answer.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'The search query.' }
        },
        required: ['query']
      }
    },
    {
      name: 'run_command',
      description: 'Run a shell command in a real, sandboxed Node.js terminal (with network access) running in the user\'s browser. Use for installing dependencies, running scripts, or executing code - not for simple file reads/writes, which the other tools already handle directly.',
      parameters: {
        type: 'OBJECT',
        properties: {
          command: { type: 'STRING', description: 'The command to run, e.g. "npm install" or "node index.js".' }
        },
        required: ['command']
      }
    }
  ]
}];

async function callGeminiRaw(apiKey, model, history, includeThoughts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: history,
    tools: TOOLS_DECL,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
  };
  if (includeThoughts) {
    body.generationConfig = { thinkingConfig: { includeThoughts: true } };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data && data.error && data.error.message ? data.error.message : `Gemini API error (${res.status})`);
  }
  return data;
}

// Not every model supports thinkingConfig - remember per-model whether it
// worked so we don't pay for a failed extra round-trip on every turn.
const thinkingSupportCache = new Map();

async function callGemini(apiKey, model, history) {
  const known = thinkingSupportCache.get(model);
  const tryThoughts = known !== false;
  try {
    const data = await callGeminiRaw(apiKey, model, history, tryThoughts);
    if (known === undefined) thinkingSupportCache.set(model, tryThoughts);
    return data;
  } catch (e) {
    if (tryThoughts) {
      const data = await callGeminiRaw(apiKey, model, history, false);
      thinkingSupportCache.set(model, false);
      return data;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '4mb' }));

// Required for the browser tab to be "cross-origin isolated", which the
// in-browser terminal (StackBlitz WebContainer) needs in order to boot.
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/models', async (req, res) => {
  try {
    const apiKey = req.query.apiKey;
    if (!apiKey) return res.status(400).json({ error: 'apiKey query param is required.' });

    let all = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data && data.error && data.error.message ? data.error.message : `Failed to list models (${r.status})`);
      }
      all = all.concat(data.models || []);
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    const usable = all
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({ id: String(m.name || '').replace(/^models\//, ''), displayName: m.displayName || m.name }))
      .sort((a, b) => a.id.localeCompare(b.id));

    res.json({ models: usable });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/session', (req, res) => {
  const id = uuidv4();
  fs.mkdirSync(getWorkspaceDir(id), { recursive: true });
  sessions.set(id, []);
  res.json({ sessionId: id });
});

app.delete('/api/session/:sessionId', (req, res) => {
  try {
    const dir = getWorkspaceDir(req.params.sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    sessions.set(req.params.sessionId, []);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/upload', upload.single('zip'), (req, res) => {
  try {
    const { sessionId } = req.body;
    const base = requireWorkspace(sessionId);
    if (!req.file) return res.status(400).json({ error: 'No zip file uploaded (field name must be "zip").' });
    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(base, true);
    res.json({ ok: true, files: listFiles(base, '.') });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/files/:sessionId', (req, res) => {
  try {
    const base = requireWorkspace(req.params.sessionId);
    res.json({ files: listFiles(base, '.', 1000) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/file/:sessionId', (req, res) => {
  try {
    const base = requireWorkspace(req.params.sessionId);
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'Query param "path" is required.' });
    res.json({ path: rel, content: readFileTool(base, rel) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/download/:sessionId', (req, res) => {
  let base;
  try {
    base = requireWorkspace(req.params.sessionId);
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message });
  }
  res.attachment('workspace.zip');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500);
    res.end();
    console.error('Zip error:', err);
  });
  archive.pipe(res);
  archive.directory(base, false);
  archive.finalize();
});

// ---------------------------------------------------------------------------
// Agent loop, streamed as Server-Sent Events so the UI can show live,
// step-by-step status ("Thinking…", "Searching the web…", tool results, the
// model's own thinking-trace text, etc.) instead of one blob at the end.
//
// Most tools (list_files, read_file, ...) run synchronously here on the
// server. run_command is different: it has to execute in the *browser*
// (the WebContainer terminal), so when the model calls it we end the stream
// and wait for a follow-up request (/api/chat/command-result) with the
// output before continuing.
// ---------------------------------------------------------------------------
const pendingStates = new Map(); // sessionId -> { queue, responses, toolLog, finalText, turn }
const MAX_TURNS = 8;

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
}

function sseSend(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function runAgentStepStreaming(sessionId, apiKey, model, emit) {
  const base = requireWorkspace(sessionId);
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  const history = sessions.get(sessionId);
  let state = pendingStates.get(sessionId);

  async function doModelTurn() {
    emit({ type: 'thinking' });
    const data = await callGemini(apiKey, model, history);
    const cand = data.candidates && data.candidates[0];
    if (!cand || !cand.content) {
      return { finished: true, reply: state.finalText || '(The model returned no content. It may have been blocked - try rephrasing.)' };
    }
    const parts = cand.content.parts || [];
    history.push({ role: 'model', parts });

    const thoughtText = parts.filter(p => p.thought && p.text).map(p => p.text).join('\n');
    if (thoughtText) emit({ type: 'thought', text: thoughtText });

    const textParts = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n');
    if (textParts) {
      state.finalText += (state.finalText ? '\n' : '') + textParts;
      emit({ type: 'text', text: textParts });
    }

    state.queue = parts.filter(p => p.functionCall).map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));
    return { finished: false };
  }

  if (!state) {
    state = { queue: [], responses: [], toolLog: [], finalText: '', turn: 0 };
    pendingStates.set(sessionId, state);
    const first = await doModelTurn();
    if (first.finished) {
      pendingStates.delete(sessionId);
      emit({ type: 'done', reply: first.reply, files: listFiles(base, '.', 300) });
      return;
    }
  }

  while (true) {
    while (state.queue.length) {
      const fc = state.queue[0];
      if (fc.name === 'run_command') {
        emit({ type: 'run_command', command: fc.args.command });
        return;
      }
      state.queue.shift();
      emit({ type: 'tool_start', name: fc.name, args: fc.args });
      let output;
      try {
        if (fc.name === 'search_web') output = await searchWeb(apiKey, model, fc.args.query);
        else if (TOOL_IMPLS[fc.name]) output = TOOL_IMPLS[fc.name](base, fc.args);
        else output = `Unknown tool: ${fc.name}`;
      } catch (e) {
        output = `Error: ${e.message}`;
      }
      const logOutput = String(output).slice(0, 4000);
      state.toolLog.push({ name: fc.name, args: fc.args, output: logOutput });
      emit({ type: 'tool_end', name: fc.name, args: fc.args, output: logOutput });
      state.responses.push({ functionResponse: { name: fc.name, response: { content: String(output) } } });
    }

    const hadCalls = state.responses.length > 0;
    if (hadCalls) {
      history.push({ role: 'user', parts: state.responses });
      state.responses = [];
    }

    if (!hadCalls) {
      const reply = state.finalText || '(empty response)';
      pendingStates.delete(sessionId);
      emit({ type: 'done', reply, files: listFiles(base, '.', 300) });
      return;
    }

    state.turn++;
    if (state.turn >= MAX_TURNS) {
      state.finalText += '\n\n[Stopped after reaching the max number of tool steps for one turn.]';
      pendingStates.delete(sessionId);
      emit({ type: 'done', reply: state.finalText, files: listFiles(base, '.', 300) });
      return;
    }

    const step = await doModelTurn();
    if (step.finished) {
      pendingStates.delete(sessionId);
      emit({ type: 'done', reply: step.reply, files: listFiles(base, '.', 300) });
      return;
    }
  }
}

app.post('/api/chat', async (req, res) => {
  const { sessionId, apiKey, model, message } = req.body || {};
  if (!sessionId || !apiKey || !model || !message) {
    return res.status(400).json({ error: 'sessionId, apiKey, model and message are all required.' });
  }
  try {
    requireWorkspace(sessionId);
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message });
  }
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  sessions.get(sessionId).push({ role: 'user', parts: [{ text: message }] });
  pendingStates.delete(sessionId); // a fresh user message always starts a fresh turn

  sseHeaders(res);
  try {
    await runAgentStepStreaming(sessionId, apiKey, model, (event) => sseSend(res, event));
  } catch (e) {
    sseSend(res, { type: 'error', message: e.message });
  }
  res.end();
});

// Called by the browser after it has executed a run_command in the
// WebContainer terminal, to feed the output back and let the agent continue.
app.post('/api/chat/command-result', async (req, res) => {
  const { sessionId, apiKey, model, output, exitCode } = req.body || {};
  if (!sessionId || !apiKey || !model || output === undefined) {
    return res.status(400).json({ error: 'sessionId, apiKey, model and output are all required.' });
  }
  try {
    requireWorkspace(sessionId);
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message });
  }
  const state = pendingStates.get(sessionId);
  if (!state || !state.queue.length || state.queue[0].name !== 'run_command') {
    return res.status(409).json({ error: 'No pending command for this session.' });
  }
  const fc = state.queue.shift();
  const resultText = `Exit code: ${exitCode}\nOutput:\n${String(output).slice(0, 6000)}`;
  state.toolLog.push({ name: 'run_command', args: fc.args, output: resultText.slice(0, 4000) });
  state.responses.push({ functionResponse: { name: 'run_command', response: { content: resultText } } });

  sseHeaders(res);
  try {
    await runAgentStepStreaming(sessionId, apiKey, model, (event) => sseSend(res, event));
  } catch (e) {
    sseSend(res, { type: 'error', message: e.message });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// Whole-workspace read/write used to sync files into and out of the
// in-browser WebContainer terminal (which has its own separate filesystem).
// ---------------------------------------------------------------------------
function readWorkspaceFlat(base, maxFiles = 500, maxFileBytes = 300 * 1024, maxTotalBytes = 8 * 1024 * 1024) {
  const out = {};
  let total = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (Object.keys(out).length >= maxFiles) return;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(path.join(dir, e.name));
      } else {
        const full = path.join(dir, e.name);
        const rel = path.relative(base, full).split(path.sep).join('/');
        let buf;
        try { buf = fs.readFileSync(full); } catch (err) { continue; }
        if (buf.includes(0) || buf.length > maxFileBytes || total + buf.length > maxTotalBytes) continue;
        out[rel] = buf.toString('utf8');
        total += buf.length;
      }
    }
  }
  if (fs.existsSync(base)) walk(base);
  return out;
}

app.get('/api/workspace/:sessionId', (req, res) => {
  try {
    const base = requireWorkspace(req.params.sessionId);
    res.json({ files: readWorkspaceFlat(base) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/workspace/:sessionId/sync', (req, res) => {
  try {
    const base = requireWorkspace(req.params.sessionId);
    const files = (req.body && req.body.files) || {};
    for (const entry of fs.readdirSync(base)) {
      fs.rmSync(path.join(base, entry), { recursive: true, force: true });
    }
    for (const [rel, content] of Object.entries(files)) {
      const target = safeResolve(base, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
    res.json({ ok: true, files: listFiles(base, '.', 300) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Gemini agent web app listening on port ${PORT}`);
});
