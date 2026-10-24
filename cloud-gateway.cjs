'use strict';
// VeriMash disposable local-chain demo gateway.
// No raw JSON-RPC, administration, or arbitrary backend paths are exposed.
const http = require('node:http');
const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = 4173;
const MAX_BODY = 1024;
const RATE_WINDOW = 15 * 60 * 1000;
const LIMITS = { '/api/send': 5, '/api/replay': 15, '/api/unauthorized': 15,
  '/api/validator-test': 15, '/api/source-evidence-test': 15, '/api/integrity': 15 };
const hits = new Map();
let phase = 'starting';
let detail = 'Starting local demo networks';
function setState(next, message) { phase = next; detail = message; }
function send(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function allowRequest(req, route) {
  const now = Date.now();
  // Vercel's reverse proxy may share IPs; these limits protect the disposable demo,
  // not individual users. They intentionally bound repeated transactions.
  const key = `${req.socket.remoteAddress || 'unknown'}:${route}`;
  for (const [k, times] of hits) {
    const live = times.filter(t => now - t < RATE_WINDOW);
    if (live.length) hits.set(k, live); else hits.delete(k);
  }
  const times = hits.get(key) || [];
  if (times.length >= LIMITS[route]) return false;
  times.push(now);
  hits.set(key, times);
  return true;
}
function proxy(req, res, route) {
  const upstream = http.request({ hostname: '127.0.0.1', port: INTERNAL_PORT,
    path: route, method: req.method,
    headers: { 'content-type': 'application/json' }, timeout: 90000 }, r => {
      res.writeHead(r.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      r.pipe(res);
    });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', err => {
    console.error('Gateway upstream:', err.message);
    if (!res.headersSent) send(res, 502, {error: 'Demo backend temporarily unavailable.'});
    else res.end();
  });
  if (req.method !== 'POST') { upstream.end(); return; }
  let size = 0;
  let tooLarge = false;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) {
      tooLarge = true;
      upstream.destroy();
      if (!res.headersSent) send(res, 413, {error: 'Request too large'});
      return;
    }
    if (!tooLarge) upstream.write(chunk);
  });
  req.on('end', () => { if (!tooLarge) upstream.end(); });
  req.on('error', () => upstream.destroy());
}
function reply(req, res) {
  const route = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && (route === '/' || route === '/health')) {
    return send(res, 200, {service: 'VeriMash', status: phase, ready: phase === 'ready',
      note: detail, demoMode: 'ephemeral-local-hardhat'});
  }
  if (phase !== 'ready') {
    return send(res, 503, {error: 'Demo blockchain is starting. Try again shortly.', status: phase});
  }
  if (req.method === 'GET' && route === '/api/status') return proxy(req, res, route);
  if (req.method === 'POST' && Object.prototype.hasOwnProperty.call(LIMITS, route)) {
    const length = Number(req.headers['content-length'] || 0);
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY) {
      return send(res, 413, {error: 'Request too large'});
    }
    if (!allowRequest(req, route)) {
      return send(res, 429, {error: 'Demo request limit reached. Try again later.'});
    }
    return proxy(req, res, route);
  }
  return send(res, 404, {error: 'Endpoint unavailable on public demo.'});
}
const server = http.createServer(reply);
server.requestTimeout = 100000;
server.listen(PORT, '0.0.0.0', () => console.log(`VeriMash restricted gateway listening on 0.0.0.0:${PORT}`));
module.exports = { setState };
