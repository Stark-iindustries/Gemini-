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
There is no real terminal available to you - you cannot run shell commands, install packages, or execute code.
Instead you have these tools: list_files, read_file, write_file, delete_file, make_directory, and search_web.

Guidelines:
- Always use list_files to understand the current structure before making assumptions about it.
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
    }
  ]
}];

async function callGemini(apiKey, model, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: history,
    tools: TOOLS_DECL,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
  };
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

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

app.get('/health', (req, res) => res.json({ ok: true }));

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

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, apiKey, model, message } = req.body || {};
    if (!sessionId || !apiKey || !model || !message) {
      return res.status(400).json({ error: 'sessionId, apiKey, model and message are all required.' });
    }
    const base = requireWorkspace(sessionId);
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    const history = sessions.get(sessionId);

    history.push({ role: 'user', parts: [{ text: message }] });

    const toolLog = [];
    let finalText = '';
    const MAX_TURNS = 8;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const data = await callGemini(apiKey, model, history);
      const cand = data.candidates && data.candidates[0];
      if (!cand || !cand.content) {
        finalText = finalText || '(The model returned no content. It may have been blocked - try rephrasing.)';
        break;
      }
      const parts = cand.content.parts || [];
      history.push({ role: 'model', parts });

      const textParts = parts.filter(p => p.text).map(p => p.text).join('\n');
      if (textParts) finalText += (finalText ? '\n' : '') + textParts;

      const functionCalls = parts.filter(p => p.functionCall);
      if (functionCalls.length === 0) break;

      const responseParts = [];
      for (const fc of functionCalls) {
        const name = fc.functionCall.name;
        const args = fc.functionCall.args || {};
        let output;
        try {
          if (name === 'search_web') {
            output = await searchWeb(apiKey, model, args.query);
          } else if (TOOL_IMPLS[name]) {
            output = TOOL_IMPLS[name](base, args);
          } else {
            output = `Unknown tool: ${name}`;
          }
        } catch (e) {
          output = `Error: ${e.message}`;
        }
        toolLog.push({ name, args, output: String(output).slice(0, 4000) });
        responseParts.push({ functionResponse: { name, response: { content: String(output) } } });
      }
      history.push({ role: 'user', parts: responseParts });

      if (turn === MAX_TURNS - 1) {
        finalText += '\n\n[Stopped after reaching the max number of tool steps for one turn.]';
      }
    }

    res.json({
      reply: finalText || '(empty response)',
      toolLog,
      files: listFiles(base, '.', 300)
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Gemini agent web app listening on port ${PORT}`);
});
