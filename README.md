# Gemini Coding Agent (web)

A browser-based coding agent powered by the Gemini API. No terminal — the model
works entirely through tool calls against a per-session virtual workspace on
the server:

- **`list_files` / `read_file` / `write_file` / `delete_file` / `make_directory`** — full read/write access to a sandboxed folder
- **Upload a `.zip`** → extracted straight into the workspace
- **Download a `.zip`** → the whole workspace, zipped on the fly, any time
- **`search_web`** — the agent can search the live web (via Gemini's built-in Google Search grounding) and cite sources
- You paste your **own Gemini API key** into the page when you open it. The key lives only in your browser (localStorage + in-memory) and is sent straight through to Google on each request — it's never written to disk on the server.

## Project layout

```
server.js        Express server: sessions, zip in/out, file tools, agent loop
public/           Static frontend (chat UI, file tree, upload/download)
workspaces/       Created at runtime — one folder per session (gitignored)
```

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

No `.env` file or environment variables are required — everything (API key,
model) is entered in the browser UI.

## Deploy to Railway

1. Push this folder to a GitHub repo (or `railway init` + `railway up` from
   the CLI if you prefer not to use GitHub).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Railway auto-detects Node from `package.json` and runs `npm install` then
   `npm start`. No environment variables need to be set — do **not** put a
   `GEMINI_API_KEY` in Railway's variables, since this app is designed so
   each visitor supplies their own key in the browser.
4. Once deployed, open the generated domain, paste a Gemini API key
   (from [Google AI Studio](https://aistudio.google.com/apikey)) into the
   sidebar, and start chatting.

That's the whole deploy — a single Node service, no database, no build step.

## Live step-by-step status + markdown rendering

The chat now streams the agent's progress instead of showing one blob at the
end (`server.js` uses Server-Sent Events for `/api/chat` and
`/api/chat/command-result`):

- A pulsing "🤔 Thinking…" bubble shows while waiting on Gemini
- If the chosen model supports Gemini's "thinking" trace
  (`generationConfig.thinkingConfig.includeThoughts`), that reasoning text
  streams in as a distinct, dashed/italic bubble. Support is auto-detected
  and cached per model — models that reject the field transparently fall
  back to no thinking trace.
- Tool calls show a live status ("🔍 Searching the web for “…”…", "✍️
  Writing src/index.js…", etc.) while running, then drop into the
  collapsible tool-log line once done
- `run_command` pauses the stream, runs in the browser terminal, and the
  turn resumes automatically once it finishes

Message text is rendered as light markdown (bold `**like this**` or
`*this*`, `` `inline code` ``, ``` ```code blocks``` ```, links, and `- `
bullets) rather than raw text, since the model uses that formatting
naturally.

## The model dropdown

Instead of a free-text field, the sidebar now calls
`GET /api/models?apiKey=...` (a thin proxy to Google's
`models.list`) and shows every model that key can use with
`generateContent`, so you always get exact, currently-valid model ids —
never a guess. It refetches automatically when you paste/edit the key, and
there's a manual ⟳ refresh button too.

## The agent's terminal (run_command)

The agent now has a `run_command` tool backed by a real, sandboxed Node.js
runtime — [StackBlitz WebContainers](https://webcontainers.io) — that boots
**inside each visitor's own browser tab**, not on your server:

- No signup or API key needed for this level of usage. StackBlitz's free
  tier covers it; a paid WebContainer API license is only required for
  heavy for-profit production traffic (well beyond a personal tool).
- It has real network access (`npm install`, `fetch`, etc.) but no access
  to your Railway server or host machine — it's isolated to the visitor's
  own tab.
- Flow: the agent calls `run_command` → the server pauses that turn and
  tells the browser what to run → the browser boots/uses its WebContainer,
  runs the command, streams output into the "Agent terminal" panel (⌨️ in
  the top bar) → the result is sent back to the server so the agent can
  keep going. This means a single `/api/chat` turn may involve several
  request/response round-trips while the agent runs multiple commands.
- File sync: the server workspace and the browser's WebContainer are two
  separate filesystems. Before running a command the browser pulls the
  latest files from the server; after the command finishes it pushes its
  files (skipping `node_modules`/`.git`) back to the server, so downloads
  and the file tree stay current. This is a full resync each time, not an
  incremental diff — fine for typical project sizes, but noticeably slower
  on very large workspaces.
- Requires the page to be ["cross-origin isolated"](https://webcontainers.io/guides/quickstart#cross-origin-isolation),
  which `server.js` sets up via `Cross-Origin-Opener-Policy` /
  `Cross-Origin-Embedder-Policy` headers. If you later put this behind a
  proxy/CDN, make sure those headers survive.
- If a visitor's browser doesn't support `SharedArrayBuffer` (rare, but
  some locked-down/embedded browsers disable it), `run_command` will fail
  gracefully with an error the agent can see and react to — file tools
  keep working regardless.

## Important limitations to know about

- **Ephemeral storage.** Railway's filesystem for a service isn't persistent
  across redeploys/restarts (and won't be shared if you ever scale to
  multiple instances). Workspaces and chat history live in memory/disk on
  the single running instance and reset when it restarts. That's fine for
  "upload → have the agent work on it → download" sessions, but don't treat
  it as long-term storage. If you need persistence across restarts, mount a
  [Railway volume](https://docs.railway.com/reference/volumes) at
  `./workspaces`.
- **Single instance only.** Chat history and workspaces are kept in an
  in-memory `Map` plus local disk. If you scale the service horizontally,
  a user's requests could hit a different instance mid-conversation. Keep
  replicas at 1, or move sessions/history to Redis + object storage
  (e.g. S3) if you need to scale out.
- **No real shell.** The agent can only manipulate files through the tool
  calls above — it can't run `npm install`, execute scripts, or run tests.
  It's a file editor with web search, not a full dev environment.
- **File size limits.** Uploads are capped at 60MB; individual file reads
  are truncated at 200KB to keep requests to Gemini small.
- **Model names drift fast.** The model field is a free-text input (with a
  few suggestions) rather than a locked dropdown, because Google
  regularly renames/retires Gemini models — if you get a "model not found"
  or "no longer supported" error, open the menu (☰) and type in a current
  model id from https://ai.google.dev/gemini-api/docs/models. `search_web`
  additionally needs a model that supports Google Search grounding.

## Extending it

- Add more tools by adding a function declaration to `TOOLS_DECL` in
  `server.js` and a matching implementation in `TOOL_IMPLS`.
- Swap the in-memory `sessions` Map for Redis if you need multi-instance
  scaling.
- Add authentication in front of this if you don't want it to be a public,
  unauthenticated agent runner — right now anyone with the URL can create
  sessions and use their own key against your server.
