// Relé falso com a parte da API do ntfy que o Dalari Cine usa (publicar texto e escutar /<tópico>/json). Só para testes locais.
// Uso: node tools/fake-relay.mjs [porta]   (padrão 8899)
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function startFakeRelay({ port = 0 } = {}) {
  const topics = new Map();   // nome -> { messages: [], subs: Set<res> }
  const topic = (name) => { if (!topics.has(name)) topics.set(name, { messages: [], subs: new Set() }); return topics.get(name); };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT' };
  let seq = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = /^\/([A-Za-z0-9_-]{1,64})(\/json)?$/.exec(url.pathname);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (!m) { res.writeHead(404, cors); return res.end('{}'); }
    const t = topic(m[1]);
    if (req.method === 'POST' && !m[2]) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (Buffer.byteLength(body) > 4096) { res.writeHead(413, cors); return res.end('{}'); }
        const ev = { id: 'm' + (++seq), time: Math.floor(Date.now() / 1000), event: 'message', topic: m[1], message: body };
        t.messages.push(ev);
        for (const s of t.subs) s.write(JSON.stringify(ev) + '\n');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ev));
      });
      return;
    }
    if (req.method === 'GET' && m[2]) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ id: 'o' + (++seq), time: Math.floor(Date.now() / 1000), event: 'open', topic: m[1] }) + '\n');
      for (const ev of t.messages) res.write(JSON.stringify(ev) + '\n');        // since=... : reenvia o que está em cache
      t.subs.add(res);
      req.on('close', () => t.subs.delete(res));
      return;
    }
    res.writeHead(405, cors); res.end('{}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      messages: (name) => (topics.get(name)?.messages || []).map((e) => e.message),
      close: () => new Promise((r) => { for (const t of topics.values()) for (const s of t.subs) s.end(); server.close(r); server.closeAllConnections?.(); }),
    });
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await startFakeRelay({ port: Number(process.argv[2]) || 8899 });
  console.log('Relé falso em', r.url);
}
