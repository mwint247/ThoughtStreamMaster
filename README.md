# ThoughtStream v2

> Watch a local LLM "think" — token by token, with the next-token probability
> distribution rendered live. v2 of the zero-dependency interpretability demo,
> building on [ThoughtStream](../ThoughtStream) with the enhancements that turn
> it from a one-off viewer into an analyzable tool.

ThoughtStream v2 streams a prompt to a local Ollama instance and, for every token
the model emits, renders the **next-token probability distribution** (the tokens
it was *considering*, and how likely each was) as a live bar chart, plus the
chosen-token probability.

It is a hands-on **LLM interpretability / transparency** demo: you see, in real
time, that a language model doesn't "reason" in English — it repeatedly samples
from a probability distribution over the next token.

## What's new in v2 (vs v1)
| v1 limitation | v2 fix |
|---------------|--------|
| `top_logprobs` hard-coded to 8 | **top-K slider** (1–20) in the UI, passed through to Ollama |
| No persistence / export | **Save run** → `data/runs.jsonl`; **Export JSON** button per run |
| Single model only | **Compare mode**: same prefix, see what model A chose vs model B's next-token distribution |
| Silent logprob failure | `/api/health` **probes each model** for logprob support and labels the dropdown |
| "confidence" mislabel | relabeled **"chosen-token probability"** in the UI |

## Run it
```bash
cd ThoughtStream_v2
node server.js            # → http://localhost:5058
```
Points at `http://localhost:11434` by default. Remote/Tailscale Ollama:
```bash
OLLAMA_URL=http://100.x.x.x:11434 node server.js
```
Requires a model that returns logprobs (the `hermes3` / `qwen2.5` families do;
some GGUF builds omit them — those are flagged in the model dropdown).

## What you are looking at
- **Left panel** — the generated text, streaming token by token.
- **Right panel** — the live **next-token distribution** for the most recent token.
  The green bar is the token the model *chose*; purple bars are alternatives it
  weighed; the readout is the softmax probability of the chosen token.
- **Compare mode** — a blue "Model B" panel shows, for the *same* growing prefix,
  what model B would have chosen next. This is the genuinely interesting
  interpretability angle: where do two models disagree about what comes next?

## How it works
`server.js` (Node built-in `http`, zero dependencies) proxies Ollama's streaming
`/api/generate` with `logprobs: true` and a client-chosen `top_logprobs`. In
compare mode it makes a second, non-streaming call per token to get model B's
distribution for the accumulated prefix. The frontend (`index.html`, vanilla JS,
no build step) renders SSE-style frames over `fetch` + `ReadableStream`.

Endpoints:
- `GET /api/health` — Ollama up/down + model list with **logprob-support probe**.
- `POST /api/stream` — single-model stream of `{ token, top, confidence }`.
- `POST /api/compare` — A's stream plus `topB` / `confidenceB` for model B.
- `GET /api/runs` / `POST /api/save` — list / append saved runs to `data/runs.jsonl`.

## Honest limitations
- **Logprobs, not attention.** Shows the next-token distribution (the real "what
  it's weighing" signal), not attention weights (which prior tokens it looked at).
  Ollama doesn't expose raw attention without a custom build.
- **"Considering" ≠ "understanding."** Bars show likelihood, not *why*.
- **Per-token probability ≠ answer correctness.** The readout is the probability
  of that exact token, not a judgment of whether the answer is right (a fluent
  hallucination can have high per-token probability).
- Compare mode makes 2× the Ollama calls (model B is queried per emitted token),
  so it's slower and heavier on the GPU than single mode.

## Stack
- Backend: Node built-in `http` (zero dependencies).
- Frontend: single `index.html`, vanilla JS, dark "system UI" theme.
- Model: any Ollama-served model via `OLLAMA_URL`.
- Storage: `data/runs.jsonl` (append-only JSON lines).

## License
MIT.
