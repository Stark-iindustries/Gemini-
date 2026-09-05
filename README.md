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
