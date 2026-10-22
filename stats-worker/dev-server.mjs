// Prévia local do painel, sem Cloudflare: um servidor Node que usa o mesmo código do Worker e um SQLite em memória
// com dados de exemplo. Uso:  node dev-server.mjs   e abra http://127.0.0.1:8790/  (senha: teste)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from './src/index.js';

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const db = {
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return { bind: (...a) => ({ run: () => stmt.run(...a), first: async () => { const r = stmt.get(...a); return r ? { ...r } : null; }, all: async () => ({ results: stmt.all(...a).map((r) => ({ ...r })) }) }) };
  },
  async batch(list) { for (const s of list) s.run(); },
};
const env = { DB: db, PANEL_PASSWORD: 'teste' };

// dados de exemplo: ~25 instalações ao longo de 30 dias (NO_DEMO=1 para começar vazio)
const now = Math.floor(Date.now() / 1000);
const rnd = (n) => Math.floor(Math.random() * n);
const ids = Array.from({ length: 25 }, (_, i) => 'DEMO' + String(i).padStart(18, '0'));
const post = (body, t) => handle(new Request('http://x/v1/ping', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '10.0.0.' + rnd(250) } }), env, t);
for (let d = process.env.NO_DEMO ? -1 : 29; d >= 0; d--) {
  const t = now - d * 86400 - rnd(40000);
  for (const [i, id] of ids.entries()) {
    if (i > 4 + (30 - d) / 2 || Math.random() < 0.45) continue;
    const base = { v: 1, id, app: i % 5 === 0 ? '0.1.0' : '0.2.0', os: i % 4 === 0 ? 'mac' : 'win', state: 'idle' };
    await post({ ...base, ev: { n: 'room_created' } }, t);
    if (Math.random() < 0.7) {
      await post({ ...base, state: 'call', ev: { n: 'call_started' } }, t + 60);
      await post({ ...base, state: 'call', ev: { n: 'route', k: ['host', 'srflx', 'srflx', 'relay'][rnd(4)] } }, t + 90);
      await post({ ...base, state: 'room', ev: { n: 'call_ended', k: ['<5m', '5-30m', '30m-2h', '>2h'][rnd(4)] } }, t + 3000);
      if (Math.random() < 0.12) await post({ ...base, ev: { n: 'voice_failed' } }, t + 100);
      await post({ ...base, state: 'call', ev: { n: 'voice_quality', k: ['good', 'good', 'good', 'fair', 'poor'][rnd(5)] } }, t + 120);
      await post({ ...base, state: 'call', ev: { n: 'connect_time', k: ['<3s', '<3s', '3-10s', '>10s'][rnd(4)] } }, t + 70);
    }
    if (Math.random() < 0.8) {
      await post({ ...base, ev: { n: 'pair_code' } }, t + 20);
      await post({ ...base, ev: { n: 'pair_try' } }, t + 30);
      if (Math.random() < 0.9) await post({ ...base, ev: { n: 'pair_found' } }, t + 32);
      if (Math.random() < 0.8) { await post({ ...base, ev: { n: 'pair_open' } }, t + 36); await post({ ...base, ev: { n: 'pair_joined' } }, t + 38); }
      else await post({ ...base, ev: { n: 'pair_fail', k: ['timeout', 'link', 'join', 'relay'][rnd(4)] } }, t + 60);
    }
  }
}
for (const [i, id] of ids.entries()) if (!process.env.NO_DEMO && i < 6) await post({ v: 1, id, app: '0.2.0', os: 'win', state: ['idle', 'room', 'call'][i % 3] }, now - rnd(120));

http.createServer(async (req, res) => {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
  const r = await handle(new Request('http://127.0.0.1:8790' + req.url, { method: req.method, headers: req.headers, body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8790, '127.0.0.1', () => console.log('Painel de exemplo em http://127.0.0.1:8790/  (senha: teste)'));
