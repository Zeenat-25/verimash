'use strict';
// VeriMash demo-only gateway. It never exposes raw Hardhat RPC or security-test endpoints.
const http = require('node:http');
const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = 4173;
const MAX_BODY = 1024;
const hits = new Map();
const RATE_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT = 3;
let phase = 'starting';
let detail = 'Starting local demo networks';
function setState(next, message) { phase = next; detail = message; }
function send(res, code, value, headers = {}) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers});
  res.end(JSON.stringify(value));
}
function reply(req,res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    return send(res, 200, {service:'VeriMash', status:phase, ready:phase === 'ready', note:detail, demoMode:'ephemeral-local-hardhat'});
  }
  if (phase !== 'ready') return send(res,503,{error:'Demo blockchain is starting. Try again shortly.',status:phase});
  if (req.method === 'GET' && path === '/api/status') return proxy(req,res,path);
  if (req.method === 'POST' && path === '/api/send') {
    const length = Number(req.headers['content-length'] || 0);
    if (length > MAX_BODY) return send(res,413,{error:'Request too large'});
    // Do not trust arbitrary client-supplied forwarded addresses; use direct Render connection address.
    // On an edge proxy these are shared, so this is intentionally conservative.
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    for (const [ip, entries] of hits) {
      const current = entries.filter(t => now - t < RATE_WINDOW);
      if (!current.length) hits.delete(ip); else hits.set(ip,current);
    }
    const times = hits.get(key) || [];
    if (times.length >= RATE_LIMIT) return send(res,429,{error:'Demo request limit reached. Try again later.'});
    times.push(now); hits.set(key,times);
    return proxy(req,res,path);
  }
  return send(res,404,{error:'Not found. Security test and administrative endpoints are not publicly exposed.'});
}
function proxy(req,res,route) {
  const upstream = http.request({hostname:'127.0.0.1',port:INTERNAL_PORT,path:route,method:req.method,headers:{'content-type':'application/json'},timeout:90000}, r => {
    res.writeHead(r.statusCode || 502, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    r.pipe(res);
  });
  upstream.on('timeout',()=>upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', err=>{if(!res.headersSent)send(res,502,{error:'Demo backend temporarily unavailable.'});else res.end();console.error('Gateway upstream:',err.message);});
  if (req.method === 'POST') {
    let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){req.destroy();upstream.destroy();return;}upstream.write(chunk);});
    req.on('end',()=>upstream.end());
    req.on('error',()=>upstream.destroy());
  } else upstream.end();
}
const server=http.createServer(reply);
server.requestTimeout=100000;
server.listen(PORT,'0.0.0.0',()=>console.log(`VeriMash restricted gateway listening on 0.0.0.0:${PORT}`));
module.exports={setState};
