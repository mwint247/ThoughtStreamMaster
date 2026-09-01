// ThoughtStream v2 — watch an LLM "think", token by token.
// Zero-dependency Node web app. Streams a prompt to a local Ollama instance and,
// for every generated token, renders the next-token probability distribution
// (from logprobs) as a live bar chart + chosen-token probability.
//
// v2 additions over v1:
//   - top_logprobs is now a client-controlled slider (1..20), not hard-coded 8.
//   - Comparison mode: given the SAME growing prefix, see what model A *chose*
//     vs what model B would have chosen next (aligned next-token distributions).
//   - Run persistence: completed runs are saved to data/runs.jsonl and listable.
//   - Logprob-support detection: /api/health reports which models return logprobs.
//   - JSON export of a run (handled client-side from the captured stream).
//
// Run:
//   node server.js
// Then open http://localhost:5058
// Point OLLAMA_URL at your Ollama (default http://localhost:11434).
//
// What you're seeing: as the model emits each token, the bar chart shows the
// tokens it was *considering* (and how likely each was). That's the honest
// "what it's triggering" signal — the next-token distribution, not a made-up
// explanation of "why".

const http = require('http');
const fs = require('fs');
const path = require('path');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PORT = process.env.PORT || 5058;
const MAX_TOP = 20;

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const DATA_DIR = path.join(__dirname, 'data');
const RUNS_PATH = path.join(DATA_DIR, 'runs.jsonl');
fs.mkdirSync(DATA_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  // static page
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HTML);
  }

  // health + model list + logprob support probe
  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      const tags = await fetch(`${OLLAMA_URL}/api/tags`);
      if (!tags.ok) throw new Error(`tags ${tags.status}`);
      const { models = [] } = await tags.json();
      // probe first few models for logprob support (cheap 1-token gen)
      const probed = [];
      for (const m of models.slice(0, 6)) {
        let logprobs = false;
        try {
          const r = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, prompt: 'hi', stream: false, logprobs: true, top_logprobs: 1 })
          });
          const j = await r.json();
          logprobs = Array.isArray(j.logprobs) && j.logprobs.length > 0 &&
            Array.isArray(j.logprobs[0].top_logprobs);
        } catch { /* leave false */ }
        probed.push({ name: m.name, logprobs });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ollama: 'up', url: OLLAMA_URL, models: probed }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ollama: 'down', url: OLLAMA_URL, error: String(e) }));
    }
  }

  // list saved runs
  if (req.method === 'GET' && req.url === '/api/runs') {
    let runs = [];
    try {
      const raw = fs.readFileSync(RUNS_PATH, 'utf8').trim().split('\n').filter(Boolean);
      runs = raw.slice(-20).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { runs = []; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ runs }));
  }

  // save a completed run
  if (req.method === 'POST' && req.url === '/api/save') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const run = JSON.parse(body);
        run.savedAt = new Date().toISOString();
        fs.appendFileSync(RUNS_PATH, JSON.stringify(run) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // single-stream a generation
  if (req.method === 'POST' && req.url === '/api/stream') {
    return handleStream(req, res, false);
  }

  // comparison stream: aligned next-token distributions from two models
  if (req.method === 'POST' && req.url === '/api/compare') {
    return handleStream(req, res, true);
  }

  res.writeHead(404); res.end('not found');
});

// Build the candidate list from an Ollama logprobs payload (streaming chunk).
function shapeLogprobs(chunk, topK) {
  let top = [];
  let confidence = null;
  if (chunk.logprobs && Array.isArray(chunk.logprobs)) {
    const last = chunk.logprobs[chunk.logprobs.length - 1];
    if (last) {
      confidence = Math.exp(last.logprob);
      const cands = (last.top_logprobs || []).slice(0, topK);
      top = cands.map((c) => ({ token: c.token, p: Math.exp(c.logprob) }));
      if (last.token != null) top.unshift({ token: last.token, p: confidence, chosen: true });
      top.sort((a, b) => b.p - a.p);
    }
  }
  return { top, confidence };
}

// Non-streaming: get model B's next-token distribution for a given prefix.
async function nextDistForPrefix(prefix, model, temperature, topK) {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, prompt: prefix, stream: false,
      logprobs: true, top_logprobs: topK,
      options: { temperature }
    })
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const j = await r.json();
  const lp = (j.logprobs || [])[0];
  if (!lp) return { top: [], confidence: null };
  const confidence = Math.exp(lp.logprob);
  const cands = (lp.top_logprobs || []).slice(0, topK);
  const top = cands.map((c) => ({ token: c.token, p: Math.exp(c.logprob) }));
  if (lp.token != null) top.unshift({ token: lp.token, p: confidence, chosen: true });
  top.sort((a, b) => b.p - a.p);
  return { top, confidence };
}

function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

async function handleStream(req, res, compare) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const model = payload.model || 'hermes3:8b';
    const modelB = payload.modelB || model;
    const prompt = payload.prompt || '';
    const temperature = payload.temperature ?? 0.7;
    const topK = Math.max(1, Math.min(MAX_TOP, payload.top_logprobs || 8));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    try {
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, prompt, stream: true,
          logprobs: true, top_logprobs: topK,
          options: { temperature }
        })
      });
      if (!r.ok) { sse(res, { error: `Ollama returned ${r.status}` }); return res.end(); }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let prefix = prompt; // accumulated text, used for aligned comparison
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let chunk;
          try { chunk = JSON.parse(line); } catch { continue; }
          if (chunk.response) {
            const { top, confidence } = shapeLogprobs(chunk, topK);
            let ev = { token: chunk.response, top, confidence, model };
            if (compare) {
              try {
                const b = await nextDistForPrefix(prefix, modelB, temperature, topK);
                ev.modelB = modelB; ev.topB = b.top; ev.confidenceB = b.confidence;
              } catch (e) {
                ev.modelBError = String(e);
              }
            }
            prefix += chunk.response;
            sse(res, ev);
          }
          if (chunk.done) { sse(res, { done: true }); return res.end(); }
        }
      }
      sse(res, { done: true });
      res.end();
    } catch (e) {
      sse(res, { error: String(e) });
      res.end();
    }
  });
}

server.listen(PORT, () => {
  console.log(`ThoughtStream v2 running on http://localhost:${PORT}`);
  console.log(`Ollama target: ${OLLAMA_URL}`);
});
