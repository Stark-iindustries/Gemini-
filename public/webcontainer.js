import { WebContainer } from 'https://esm.sh/@webcontainer/api@1.5.1?bundle';

let bootPromise = null;
let syncedSessionId = null;
let outputHandler = () => {};

function supported() {
  return typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated === true;
}

async function ensureBooted() {
  if (!supported()) {
    throw new Error('This page is not "cross-origin isolated" in this browser, so the in-browser terminal cannot start (it needs SharedArrayBuffer).');
  }
  if (!bootPromise) {
    bootPromise = WebContainer.boot({ coep: 'credentialless' });
  }
  return bootPromise;
}

// Turn a flat { "dir/file.js": "content" } map into the nested tree shape
// the WebContainer mount() call expects.
function buildTree(files) {
  const tree = {};
  for (const [relPath, content] of Object.entries(files)) {
    const parts = relPath.split('/').filter(Boolean);
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      node[seg] = node[seg] || { directory: {} };
      node = node[seg].directory;
    }
    node[parts[parts.length - 1]] = { file: { contents: content } };
  }
  return tree;
}

async function flattenContainerFs(wc, dir = '.') {
  const out = {};
  let entries;
  try {
    entries = await wc.fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      Object.assign(out, await flattenContainerFs(wc, full));
    } else {
      try {
        out[full] = await wc.fs.readFile(full, 'utf-8');
      } catch (e) {
        // binary or unreadable - skip
      }
    }
  }
  return out;
}

async function pullFromServer(sessionId) {
  const res = await fetch(`/api/workspace/${sessionId}`);
  const data = await res.json();
  const wc = await ensureBooted();
  await wc.mount(buildTree(data.files || {}));
}

async function pushToServer(sessionId) {
  const wc = await ensureBooted();
  const files = await flattenContainerFs(wc);
  await fetch(`/api/workspace/${sessionId}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files })
  });
}

function setOutputHandler(fn) {
  outputHandler = fn || (() => {});
}

async function runCommand(sessionId, commandLine) {
  // Always resync from the server first: the agent's own file tools run
  // server-side and may have changed things since the terminal last ran.
  await pullFromServer(sessionId);
  syncedSessionId = sessionId;

  const wc = await ensureBooted();
  const trimmed = String(commandLine || '').trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  outputHandler(`$ ${trimmed}\n`);

  let exitCode = -1;
  let captured = '';
  try {
    const proc = await wc.spawn(cmd, args);
    proc.output.pipeTo(new WritableStream({
      write(data) {
        captured += data;
        outputHandler(data);
      }
    }));
    exitCode = await proc.exit;
  } catch (e) {
    outputHandler(`\nFailed to run command: ${e.message}\n`);
    await pushToServer(sessionId);
    return { output: `Failed to run command: ${e.message}`, exitCode };
  }

  outputHandler(`\n[exit code ${exitCode}]\n`);
  await pushToServer(sessionId);
  return { output: captured || '(no output)', exitCode };
}

window.AgentTerminal = { supported, runCommand, setOutputHandler };
