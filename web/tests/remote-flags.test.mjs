import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRemoteFlags } = require('../server/remote-flags.js');
const { createRoomService } = require('../server/room-service.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const reply = (b, status = 200) => async () => new Response(JSON.stringify(b), { status });

test('chave remota: Netflix ligada por padrão e só desliga quando o Worker manda; a mensagem é limpa e limitada', async () => {
  const on = createRemoteFlags({ url: 'https://stats.example/v1/flags', fetchImpl: reply({ ok: true, netflix: true }) });
  assert.deepEqual(await on.get(), { netflix: true, message: '' });
  const off = createRemoteFlags({ url: 'https://stats.example/v1/flags', fetchImpl: reply({ ok: true, netflix: false, message: 'Manutenção <b>da Netflix</b>\n' + 'x'.repeat(400) }) });
  const f = await off.get();
  assert.equal(f.netflix, false);
  assert.ok(f.message.startsWith('Manutenção') && !/[<>\n]/.test(f.message) && f.message.length <= 200);
});

test('chave remota: sem rede, resposta ruim ou sem endereço nunca desliga; se já estava desligada, vale por 1 hora sem confirmação', async () => {
  for (const url of [undefined, '', 'http://stats.example/v1/flags']) assert.deepEqual(await createRemoteFlags({ url, fetchImpl: reply({ ok: true, netflix: false }) }).get(), { netflix: true, message: '' }, String(url));
  for (const r of [reply({ ok: false }, 503), reply('x'), reply({ ok: true, netflix: 'nao' }), reply({ netflix: false })]) {
    assert.equal((await createRemoteFlags({ url: 'https://stats.example/v1/flags', fetchImpl: r }).get()).netflix, true);
  }
  let t = 1_000_000, mode = 'off';
  const fetchImpl = async () => { if (mode === 'down') throw new TypeError('sem rede'); return new Response(JSON.stringify({ ok: true, netflix: false }), { status: 200 }); };
  const flags = createRemoteFlags({ url: 'https://stats.example/v1/flags', fetchImpl, now: () => t });
  assert.equal((await flags.get()).netflix, false);
  mode = 'down'; t += 6 * 60000;
  assert.equal((await flags.get()).netflix, false, 'queda breve de rede: continua desligada');
  t += 61 * 60000;
  assert.equal((await flags.get()).netflix, true, 'passou 1 hora sem confirmar: não prende o app');
});

test('chave remota: consulta no máximo a cada 5 minutos e junta pedidos simultâneos', async () => {
  let t = 5_000_000, calls = 0;
  const flags = createRemoteFlags({ url: 'https://stats.example/v1/flags', fetchImpl: async () => { calls++; return new Response(JSON.stringify({ ok: true, netflix: true }), { status: 200 }); }, now: () => t });
  await Promise.all([flags.get(), flags.get(), flags.get()]);
  assert.equal(calls, 1);
  t += 4 * 60000; await flags.get(); assert.equal(calls, 1);
  t += 2 * 60000; await flags.get(); assert.equal(calls, 2);
});

async function boot(extra = {}) {
  const svc = createRoomService({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], servePrototype: true, ...extra });
  const addr = await svc.listen(0, '127.0.0.1');
  return { svc, url: `http://127.0.0.1:${addr.port}` };
}

test('serviço: /v1/local/flags entrega a chave só no próprio computador e nunca falha por causa dela', async () => {
  const { svc, url } = await boot({ remoteFlags: { async get() { return { netflix: false, message: 'Netflix em manutenção' }; } } });
  try {
    const d = await (await fetch(url + '/v1/local/flags')).json();
    assert.deepEqual(d, { ok: true, netflix: false, message: 'Netflix em manutenção' });
    assert.equal((await fetch(url + '/v1/local/flags')).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url + '/v1/local/flags?x=1')).status, 400);
    assert.equal((await fetch(url + '/v1/local/flags', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/v1/local/flags', { headers: { Origin: 'https://evil.example' } })).status, 403);
  } finally { await svc.close(); }
  const broken = await boot({ remoteFlags: { async get() { throw new Error('quebrou'); } } });
  try { assert.deepEqual(await (await fetch(broken.url + '/v1/local/flags')).json(), { ok: true, netflix: true }); } finally { await broken.svc.close(); }
  const none = await boot({});
  try { assert.deepEqual(await (await fetch(none.url + '/v1/local/flags')).json(), { ok: true, netflix: true }); } finally { await none.svc.close(); }
  const plain = await createRoomService({ iceServers: [] }); const a = await plain.listen(0, '127.0.0.1');
  try { assert.equal((await fetch(`http://127.0.0.1:${a.port}/v1/local/flags`)).status, 403, 'fora do modo local recusa'); } finally { await plain.close(); }
});

test('ligações: o servidor do app liga a chave ao Worker e a interface trava a Netflix nos pontos de entrada', () => {
  const index = read('../server/index.js');
  assert.match(index, /createRemoteFlags\(\{ url: origin \+ '\/v1\/flags' \}\)/);
  assert.match(index, /remoteFlags\?\.warm\(\);/);
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes("fetch(location.origin + '/v1/local/flags'"));
  assert.ok(ui.includes("if (platform === 'netflix' && netflixLockReason()) { say(netflixLockReason()); return; }"), 'preparar a plataforma');
  assert.ok(ui.includes("if (b.dataset.platform === 'netflix') { await refreshNetflixFlag(true); if (netflixLockReason())"), 'trocar a plataforma na sala');
  assert.ok(ui.includes("window.duoDesktop?.setPlatform(s.status === 'active' && !nfBlocked ? s.platform : null)"), 'a janela da Netflix não abre travada');
  assert.ok(ui.includes("key === 'netflix' && snapshot.platform !== 'netflix' && netflixLockReason()"), 'botão da Netflix fica desligado');
  for (const word of ["'api-missing'", 'M7375', "'seek-unavailable'", 'nfSeekFails >= 3', 'NF_LOCK_MS = 30 * 60 * 1000']) assert.ok(ui.includes(word.replace('nfSeekFails >= 3', '++nfSeekFails >= 3')) || ui.includes(word), word);
});

test('Netflix: o título que o Host começa a tocar vira o da sala sozinho, e dá para trocar depois', () => {
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes('async function autoAssociateNetflix(event)'));
  assert.ok(ui.includes('void autoAssociateNetflix(event);'));
  const at = ui.indexOf('async function autoAssociateNetflix(event)');
  const body = ui.slice(at, at + 900);
  for (const must of ["client.role !== 'host'", "snapshot.platform !== 'netflix'", 'snapshot.media', 'event.playing !== true', 'nfAutoTried.has(event.watchId)']) assert.ok(body.includes(must), must);
  assert.ok(ui.includes("'nf-desktop-swap'") && ui.includes("act === 'nf-desktop-swap'"));
  assert.ok(ui.includes('nfAutoTried.clear()'), 'ao sair da sala, recomeça');
  // o botão antigo de associar à mão continua como plano B
  assert.ok(ui.includes("act === 'nf-desktop-associate'"));
});
