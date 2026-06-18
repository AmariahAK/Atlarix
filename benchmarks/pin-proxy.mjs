#!/usr/bin/env node
/**
 * Pin-injecting OpenRouter proxy for the Terminal-Bench harness comparison.
 *
 * Every harness (atlarix / opencode / pi) points its OpenAI-compatible base URL
 * at this proxy. The proxy looks at `body.model`, injects the per-model
 * OpenRouter `provider` routing block (so the provider/quant is identical across
 * all three harnesses — the "fixed provider" axis), then forwards to OpenRouter
 * with the benchmark key (held server-side; never sent to the sandboxes).
 *
 * This is the only place the pin is applied, so opencode/pi — which can't carry
 * an OpenRouter `provider` block themselves — end up pinned too, with zero prod
 * risk (the prod key never enters this path).
 *
 * Env:
 *   OPENROUTER_API_KEY   required — the BENCHMARK key
 *   PORT                 default 4000
 *
 * Endpoints: OpenAI-compatible. Forwards any path under the listen root to
 * https://openrouter.ai/api/<path>. Injects `provider` only on chat/completions.
 *
 * Dependency-free (Node 18+ global fetch + node:http). Run: node pin-proxy.mjs
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 4000);
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("[pin-proxy] FATAL: OPENROUTER_API_KEY not set");
  process.exit(1);
}
const UPSTREAM = "https://openrouter.ai/api"; // request path already carries /v1

// Per-model provider pin: cheapest provider that ACTUALLY SERVES RELIABLY +
// supports tool-calling. Verified live against the OpenRouter API with a 4-shot
// capacity probe (a benchmark needs a provider that holds up under load, not
// just the cheapest sticker price). Both fp8 — identical quant class.
//   deepseek/deepseek-v4-pro -> GMICloud fp8 ($1.131/$2.262), 4/4 clean.
//     Cheaper providers were rejected for thin shared capacity: first-party
//     'deepseek' 404s (no live endpoint), Baidu fp8 ($0.76) + DeepInfra fp4 +
//     Fireworks all returned 429 "temporarily rate-limited upstream" even at
//     low rate. GMICloud and Novita (pricier) were the only 4/4; GMICloud wins
//     on price.
//   minimax/minimax-m3       -> MiniMax fp8 ($0.30/$1.20), first-party, 4/4 clean.
const PINS = {
  "deepseek/deepseek-v4-pro": { order: ["gmicloud/fp8"], allow_fallbacks: false, quantizations: ["fp8"] },
  "minimax/minimax-m3": { order: ["minimax/fp8"], allow_fallbacks: false, quantizations: ["fp8"] },
};

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding",
]);

let reqCount = 0;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const server = http.createServer(async (req, res) => {
  const id = ++reqCount;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let bodyBuf = Buffer.concat(chunks);

    const isChat = req.method === "POST" && /\/chat\/completions\/?$/.test(req.url.split("?")[0]);
    let pinned = null, model = null;
    if (isChat && bodyBuf.length) {
      let body;
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch (e) {
        log({ id, event: "bad_json", err: String(e) });
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"pin-proxy: invalid JSON body"}');
        return;
      }
      model = body.model;
      const pin = PINS[model];
      if (pin) {
        body.provider = pin; // <-- the injection: identical routing for every harness
        pinned = pin;
      }
      bodyBuf = Buffer.from(JSON.stringify(body));
    }
    log({ id, event: "request", method: req.method, url: req.url, model, pinned, injected: !!pinned });

    const headers = {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "http-referer": "https://atlarix.bench",
      "x-title": "atlarix-terminal-bench",
    };

    const upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers,
      // eslint-disable-next-line unicorn/no-invalid-fetch-options -- body is already nullified for GET/HEAD via the ternary; the rule can't see through it
      body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuf,
    });

    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
    log({ id, event: "response", status: upstream.status });
  } catch (e) {
    log({ id, event: "error", err: String(e && e.stack ? e.stack : e) });
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(`{"error":"pin-proxy upstream error: ${String(e).replace(/"/g, "'")}"}`);
  }
});

server.listen(PORT, "0.0.0.0", () => log({ event: "listening", port: PORT, pins: Object.keys(PINS) }));
