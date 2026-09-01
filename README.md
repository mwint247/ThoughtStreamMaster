# ThoughtStream v2 — Project Documentation

> Single source of truth for what each part of ThoughtStream does, *why* it exists,
> and *examples* of how it behaves. Covers every file in the project after the v1
> cleanup (scratch scripts `_diag_ts.py`, `_shot_*.py`, `_preview_*.png`, and
> `server.mock.js` were removed).

---

## Table of contents
1. [server.js](#1-serverjs) — the backend streaming proxy
2. [index.html](#2-indexhtml) — the frontend (UI + live chart)
3. [README.md](#3-readmemd) — run instructions + honest limitations
4. [OBSERVABILITY_PITCH.md](#4-observability_pitchmd) — the "why it matters" pitch

---

## 1. `server.js`
**What it does:** A zero-dependency Node HTTP server (uses only built-in `http`,
`fs`, `path`) that acts as a thin proxy between the browser and a local Ollama
instance. It serves the static `index.html` and exposes one streaming endpoint
that forwards a prompt to Ollama and relays each generated token **plus its
next-token probability distribution** to the browser as Server-Sent-style events.

**Why it exists:** Ollama's `/api/generate` returns logprobs, but a browser can't
call Ollama directly with CORS + streaming easily, and you don't want the model
URL/secret logic in the client. This server keeps the browser dumb (it just
POSTs a prompt) and does the streaming/probability-shaping work server-side.

**Key behaviors:**
- `GET /` → serves `index.html`.
- `GET /api/health` → pings `OLLAMA_URL/api/tags`; returns `{ ollama: 'up'|'down', url }`. Lets the UI show an Ollama status badge.
- `POST /api/stream` → the core. Body: `{ prompt, model, temperature }`.
  - Calls Ollama `/api/generate` with `stream: true`, `logprobs: true`, `top_logprobs: 8`, `options.temperature`.
  - For each Ollama chunk that has a `response` token, it builds a `top` array from `chunk.logprobs[last].top_logprobs` (capped at 8), prepends the **chosen** token with `chosen: true`, sorts by probability, and emits `data: { token, top, confidence }`.
  - `confidence` = `exp(chosen_logprob)` — the softmax probability of the single chosen token.
  - Emits `{ done: true }` when Ollama signals `chunk.done`.
  - On Ollama error/non-200 → emits `{ error: ... }`.
- `OLLAMA_URL` (default `http://localhost:11434`) and `PORT` (default `5057`) come from env.
- Sends `Access-Control-Allow-Origin: *` so it can be hit from any local origin.

**Example emitted event (what the browser receives per token):**
```json
data: {"token":" blue","top":[
  {"token":" blue","p":0.91,"chosen":true},
  {"token":" blue.","p":0.04},
  {"token":"Blue","p":0.02},
  {"token":" a","p":0.01}
],"confidence":0.91}

data: {"done":true}
```

**Example curl (manual test, no browser):**
```bash
curl -N -X POST http://localhost:5057/api/stream \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Why is the sky blue?","model":"hermes3:8b","temperature":0.7}'
```

**Known limits (v1):** `top_logprobs` is hard-coded to 8; no persistence; single
model per request; confidence is per-token probability, not answer correctness.
(See README "Honest limitations" + the limitations write-up for the full list.)

---

## 2. `index.html`
**What it does:** A single-file frontend (vanilla JS, no framework, no build step)
with three regions: a top bar (model picker, temperature, Generate/Stop), a left
"Generated stream" panel, and a right "What it's considering" panel that renders
the live next-token distribution as bars.

**Why it exists:** To make the abstract "next-token distribution" *visible and
intuitive* — a bar chart is far easier to grok than a JSON log. Keeping it as one
file with no dependencies means anyone can open it after `node server.js` with
zero setup.

**Key behaviors:**
- On load, `fetch('/api/health')` sets the Ollama up/down status badge.
- `Generate` opens a `fetch` + `ReadableStream` to `/api/stream`, reads SSE-style
  `data: {...}` frames, and for each:
  - appends `obj.token` to the left output panel,
  - calls `renderBars(obj.top, obj.confidence)` on the right panel,
  - updates the `confidence: NN.N%` readout.
- `renderBars` draws up to 8 rows; the chosen token is green (`fill chosen`),
  alternatives purple; widths scaled to the max probability in that frame.
- `Stop` uses an `AbortController` to cancel the in-flight stream.
- Cosmetic helpers: `⏎` for newline tokens, `·` for spaces; `escapeHtml` prevents
  injection from model output.
- Dark "system UI" theme via CSS variables.

**Example of the live experience:**
- You type *"Explain in one sentence why the sky is blue."* and click Generate.
- Left panel streams: `The sky appears blue because sunlight is scattered by…`
- Right panel, on the token ` blue`, shows a tall green bar ` blue 91.0%` and
  shorter purple bars ` blue. 4.0%`, `Blue 2.0%`, ` a 1.0%`.

**Cleanup note (v1):** removed dead `EventSource` lines that were created then
immediately closed (the code uses `fetch`+`ReadableStream` instead).

---

## 3. `README.md`
**What it does:** The user-facing doc — what ThoughtStream is, how to run it,
what you're looking at, how it works, and an **"Honest limitations"** section.

**Why it exists:** So a visitor (or future you) can run it in one command and
understand *what the bars mean* without reading source. The "Honest limitations"
section is deliberate: it pre-empts the misconception that this shows "reasoning"
rather than next-token sampling.

**Covers:**
- Run: `node server.js` → `http://localhost:5057`; `OLLAMA_URL` for remote/Tailscale Ollama.
- What the panels show (left = text, right = next-token distribution + confidence).
- How it works (Ollama `logprobs: true`, `top_logprobs: 8`, SSE over fetch).
- Honest limitations: logprobs not attention; "considering" ≠ "understanding";
  needs a model that returns logprobs.
- "How this relates to the real world": maps the concept to OpenAI logprobs,
  Anthropic attribution graphs, Neuronpedia, and LLM observability platforms
  (LangSmith, Helicone, Arize Phoenix) — framing ThoughtStream as the local,
  teaching-grade cousin.
- Stack + MIT license.

**v1 change:** removed the `server.mock.js` offline-preview section (mock server
deleted in cleanup).

---

## 4. `OBSERVABILITY_PITCH.md`
**What it does:** A positioning/pitch document (2.7 KB) that frames ThoughtStream
as part of a broader "LLM observability" story — connecting it to the sibling
**LLM Quality Lab** (a confidence-scored eval harness) as a mini, self-hosted
observability stack.

**Why it exists:** To articulate *value* beyond "cool demo" — i.e. that watching
per-token distributions is the same primitive production systems use for confidence
scoring, uncertainty routing ("model unsure → escalate"), and calibration. Useful
for resumes/portfolio framing (maps to "evaluation & tracing, monitoring for
cost/usage/performance").

**Thesis:** ThoughtStream (transparency) + LLM Quality Lab (evaluation) together
form a local, privacy-first observability stack in the spirit of LangSmith /
Helicone / Phoenix — but runnable with Node + a local model, no cloud, no secrets.

---

## How the pieces fit together (data flow)
```
Browser (index.html)
   │  POST /api/stream {prompt, model, temperature}
   ▼
server.js  (Node http, zero-dep)
   │  POST Ollama /api/generate {logprobs:true, top_logprobs:8, stream:true}
   ▼
Ollama (local, e.g. hermes3:8b @ :11434)
   │  streams chunks: {response, logprobs:[{token, logprob, top_logprobs}]}
   ▼
server.js shapes each → {token, top:[{token,p,chosen?}], confidence}
   │  SSE  data: {...}\n\n
   ▼
Browser renders text (left) + next-token bars + confidence (right)
```

## Run it (canonical)
```bash
cd ThoughtStream
node server.js                 # → http://localhost:5057
# optionally point at a remote Ollama:
OLLAMA_URL=http://100.x.x.x:11434 node server.js
```
Open the URL, pick a model (`hermes3:8b`, `gemma4:e4b`, `qwen2.5-coder:1.5b`),
set temperature, type a prompt, click **Generate**.

## Files at a glance (post v1 cleanup)
| File | Role | Deps |
|------|------|------|
| `server.js` | Backend streaming proxy → Ollama | Node built-ins only |
| `index.html` | Frontend UI + live next-token chart | Vanilla JS, no build |
| `README.md` | Run + honest-limitations doc | — |
| `OBSERVABILITY_PITCH.md` | Portfolio/value positioning | — |

*(Removed in v1: `_diag_ts.py`, `_shot_active.py`, `_shot_ts.py`, `_preview_active.png`,
`_preview_thoughtstream.png`, `server.mock.js` — all scratch/diagnostic artifacts.)*

