import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { startFakeRelay } from '../tools/fake-relay.mjs';
const require = createRequire(import.meta.url);
const R = require('../server/p2p-rendezvous.js');
const { createReconnector, GUEST_MAX_MS, HOST_MAX_MS, BACKOFF_MS } = require('../server/reconnect.js');

// relógio e "espera" de mentira: cada sleep avança o tempo, sem esperar de verdade
function rig(overrides = {}) {
  const clock = { t: 0 }, slept = [], events = [];
  const rc = createReconnector({
    now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms; },
    onState: (s) => events.push(s), ...overrides,
  });
  return { rc, clock, slept, events };
}

test('tenta de novo com intervalos crescentes até conseguir', async () => {
  let calls = 0;
  const { rc, slept, events } = rig({ attempt: async (n) => { calls = n; return n === 4; } });
  assert.equal(await rc.run(), true);
  assert.equal(calls, 4);
  assert.deepEqual(slept, [2000, 4000, 8000], 'esperou entre as tentativas, mas não depois do sucesso');
  assert.deepEqual(events.map((e) => e.phase), ['start', 'try', 'try', 'try', 'try', 'ok']);
});

test('exceção numa tentativa não derruba a reconexão e o intervalo para de crescer no teto', async () => {
  const { rc, slept, events } = rig({ attempt: async (n) => { if (n < 7) throw new Error('rede ' + n); return true; } });
  assert.equal(await rc.run(), true);
  assert.deepEqual(slept, [2000, 4000, 8000, 15000, 15000, 15000]);
  assert.equal(events.filter((e) => e.phase === 'fail').length, 6);
  assert.equal(events.find((e) => e.phase === 'fail').error.message, 'rede 1');
});

test('desiste no limite de tempo, e o Host espera mais que o convidado', async () => {
  const g = rig({ attempt: async () => false, maxMs: GUEST_MAX_MS });
  assert.equal(await g.rc.run(), false);
  assert.equal(g.events.at(-1).phase, 'giveup');
  assert.ok(g.clock.t >= GUEST_MAX_MS && g.clock.t < GUEST_MAX_MS + BACKOFF_MS.at(-1) + 1, 'parou logo depois do limite');
  assert.ok(HOST_MAX_MS > GUEST_MAX_MS);
  const h = rig({ attempt: async () => false, maxMs: HOST_MAX_MS });
  assert.equal(await h.rc.run(), false);
  assert.ok(h.events.filter((e) => e.phase === 'try').length > g.events.filter((e) => e.phase === 'try').length);
});

test('shouldContinue encerra (sala fechada, pessoa saiu) e stop() interrompe no meio', async () => {
  let open = true;
  const a = rig({ attempt: async (n) => { if (n === 2) open = false; return false; }, shouldContinue: () => open });
  assert.equal(await a.rc.run(), false);
  assert.equal(a.events.filter((e) => e.phase === 'try').length, 2);
  assert.equal(a.events.at(-1).phase, 'giveup');

  let r;
  const b = rig({ attempt: async () => { r.stop(); return false; } });
  r = b.rc;
  assert.equal(await b.rc.run(), false);
  assert.equal(b.events.at(-1).phase, 'stopped');
});

test('uma rodada por vez: chamar de novo enquanto roda não abre outra; depois que termina pode rodar de novo', async () => {
  let release; const gate = new Promise((res) => { release = res; });
  let attempts = 0;
  const { rc } = rig({ attempt: async () => { attempts++; await gate; return true; } });
  const first = rc.run();
  assert.equal(rc.running, true);
  assert.equal(await rc.run(), false, 'segunda chamada simultânea é recusada');
  release();
  assert.equal(await first, true);
  assert.equal(rc.running, false);
  assert.equal(await rc.run(), true);
  assert.equal(attempts, 2);
});

test('um onState que lança não atrapalha; attempt é obrigatório', async () => {
  const { rc } = rig({ attempt: async () => true, onState: () => { throw new Error('aviso quebrou'); } });
  assert.equal(await rc.run(), true);
  assert.throws(() => createReconnector({}), /attempt/);
});

test('código de reencontro: igual nos dois lados, diferente do original, por sala, no formato do código curto', async () => {
  const a = await R.deriveReconnectCode('K7QM-93XP', '123456'), b = await R.deriveReconnectCode('k7qm93xp', '123456');
  assert.equal(a, b, 'maiúsculas, hífen e espaços não mudam o resultado');
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.notEqual(a, 'K7QM-93XP');
  assert.notEqual(a, await R.deriveReconnectCode('K7QM-93XP', '123457'), 'outra sala, outro código');
  assert.notEqual(a, await R.deriveReconnectCode('K7QM-93XQ', '123456'), 'outro pareamento, outro código');
  assert.equal(R.normalizeCode(a), a.replace('-', ''), 'serve como código curto normal');
  for (const [code, room] of [['curto', '123456'], ['K7QM-93XP', '12345'], ['K7QM-93XP', 'abcdef'], [null, '123456']]) {
    await assert.rejects(() => R.deriveReconnectCode(code, room), /inválido/);
  }
  const keysA = await R.deriveKeys(a), keysOriginal = await R.deriveKeys('K7QM-93XP');
  assert.notEqual(keysA.toHost, keysOriginal.toHost, 'tópicos do relé diferentes dos do pareamento original');
});

test('reencontro completo: o Host escuta o código derivado e o convidado volta pelo mesmo caminho do pareamento', async () => {
  const relay = await startFakeRelay();
  try {
    const client = new R.Relay({ baseUrl: relay.url });
    const original = 'K7QM-93XP', room = '123456';
    // 1) pareamento original (uso único)
    const first = R.hostListen({ code: original, relay: client, respond: async () => ({ answer: 'DT2.RESPOSTA-1', extra: { room } }) });
    await new Promise((r) => setTimeout(r, 50));
    await R.guestPair({ code: original, relay: client, offer: 'DT2.OFERTA-1', timeoutMs: 5000 });
    await first.result;
    // 2) a conexão cai: cada lado deriva o mesmo código, sem se falar
    const hostCode = await R.deriveReconnectCode(original, room), guestCode = await R.deriveReconnectCode(original.toLowerCase().replace('-', ' '), room);
    assert.equal(hostCode, guestCode);
    const seen = [];
    const second = R.hostListen({ code: hostCode, relay: client, respond: async (offer) => { seen.push(offer); return { answer: 'DT2.RESPOSTA-2', extra: { room } }; } });
    await new Promise((r) => setTimeout(r, 50));
    const out = await R.guestPair({ code: guestCode, relay: client, offer: 'DT2.OFERTA-2', timeoutMs: 5000 });
    assert.deepEqual(out, { answer: 'DT2.RESPOSTA-2', extra: { room } });
    assert.deepEqual(seen, ['DT2.OFERTA-2']);
    await second.result;
    // 3) o código original continua sem servir para reencontro, e o relé nunca viu nada em claro
    const keys = await R.deriveKeys(hostCode);
    const raw = [...relay.messages(keys.toHost), ...relay.messages(keys.toGuest)].join('|');
    assert.equal(raw.includes('OFERTA') || raw.includes('RESPOSTA') || raw.includes(room), false);
  } finally { await relay.close(); }
});

test('segunda queda seguida: o Host não atende de novo a oferta antiga que o relé ainda repete', async () => {
  const relay = await startFakeRelay();
  try {
    const client = new R.Relay({ baseUrl: relay.url });
    const rcode = await R.deriveReconnectCode('K7QM-93XP', '123456');
    const seen = new Set(), answeredA = [], answeredB = [], answeredC = [];
    // 1ª queda: o convidado oferece OFERTA-1 e o Host atende
    const a = R.hostListen({ code: rcode, relay: client, seen, respond: async (o) => { answeredA.push(o); return { answer: 'DT2.R1' }; } });
    await new Promise((r) => setTimeout(r, 50));
    await R.guestPair({ code: rcode, relay: client, offer: 'DT2.OFERTA-1', timeoutMs: 5000 });
    await a.result;
    // sem a proteção, o relé repetiria OFERTA-1 e ela seria atendida de novo
    const without = R.hostListen({ code: rcode, relay: client, respond: async (o) => { answeredC.push(o); return { answer: 'DT2.RX' }; } });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(answeredC, ['DT2.OFERTA-1'], 'confirma o problema: sem o conjunto "seen" a oferta velha é reaproveitada');
    await without.result;
    // 2ª queda: com o conjunto, só a oferta nova é atendida
    const b = R.hostListen({ code: rcode, relay: client, seen, respond: async (o) => { answeredB.push(o); return { answer: 'DT2.R2' }; } });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(answeredB, [], 'a oferta velha é ignorada');
    const out = await R.guestPair({ code: rcode, relay: client, offer: 'DT2.OFERTA-2', timeoutMs: 5000 });
    assert.equal(out.answer, 'DT2.R2');
    await b.result;
    assert.deepEqual(answeredB, ['DT2.OFERTA-2']);
    assert.equal(seen.size, 2, 'as duas ofertas atendidas ficam registradas');
  } finally { await relay.close(); }
});

test('a página carrega o controlador e o online-ui religa a conexão do convidado e a do Host', () => {
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<script src="server\/reconnect\.js"><\/script>/);
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/server\/reconnect\.js', 'server\/reconnect\.js'/);
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  for (const needle of ['DuoReconnect', 'deriveReconnectCode', 'startGuestReconnect', 'startHostReconnect']) assert.match(ui, new RegExp(needle), needle);
});
