import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFakeRelay } from '../tools/fake-relay.mjs';
const require = createRequire(import.meta.url);
const R = require('../server/p2p-rendezvous.js');

test('código: 8 caracteres do alfabeto sem ambíguos, mostrado XXXX-XXXX; normaliza O/I/L, espaços e minúsculas', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = R.newCode();
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(R.normalizeCode(c), c.replace('-', ''));
    seen.add(c);
  }
  assert.ok(seen.size > 190, 'códigos aleatórios');
  assert.equal(R.normalizeCode(' k7qm 93xp '), 'K7QM93XP');
  assert.equal(R.normalizeCode('0O1IL-000'), '00111000');   // O→0, I e L→1
  for (const bad of ['', 'ABC', 'K7QM-93X', 'K7QM-93XPZ', 'K7QM-93X!', 'DT2.abcdefgh']) assert.equal(R.normalizeCode(bad), null, bad);
  assert.equal(R.looksLikeShortCode('K7QM-93XP'), true);
  assert.equal(R.looksLikeShortCode('DT2.QEwdnQ-F1'), false);
  assert.equal(R.looksLikeShortCode('123456.' + 'a'.repeat(43)), false);
});

test('chaves: determinísticas por código, tópicos distintos, e mensagens só abrem com o código certo', async () => {
  const a = await R.deriveKeys('K7QM-93XP'), b = await R.deriveKeys('k7qm93xp'), c = await R.deriveKeys('K7QM-93XQ');
  assert.equal(a.toHost, b.toHost); assert.equal(a.toGuest, b.toGuest);
  assert.notEqual(a.toHost, a.toGuest); assert.notEqual(a.toHost, c.toHost);
  assert.match(a.toHost, /^duo-[0-9a-f]{32}$/);
  const msg = await R.seal(a.key, { t: 'offer', c: 'DT2.xyz', exp: 1 });
  assert.deepEqual(await R.open(b.key, msg), { t: 'offer', c: 'DT2.xyz', exp: 1 });
  assert.equal(await R.open(c.key, msg), null);                          // código errado
  assert.equal(await R.open(a.key, msg.slice(0, -3) + 'AAA'), null);     // adulterada
  assert.equal(await R.open(a.key, 'lixo'), null);
  assert.equal(msg.includes('DT2'), false);                               // o conteúdo não aparece em claro
  await assert.rejects(() => R.deriveKeys('curto'), /inválido/);
});

async function withRelay(fn) {
  const relay = await startFakeRelay();
  try { await fn(relay, new R.Relay({ baseUrl: relay.url })); } finally { await relay.close(); }
}

test('pareamento: convidado publica a oferta, Host (já escutando) responde com a sala, e o relé só vê texto cifrado', async () => {
  await withRelay(async (relay, client) => {
    const code = R.newCode();
    const seen = [];
    const host = R.hostListen({ code, relay: client, respond: async (offer) => { seen.push(offer); return { answer: 'DT2.RESPOSTA', extra: { room: '123456' } }; } });
    await new Promise((r) => setTimeout(r, 50));
    const out = await R.guestPair({ code, relay: client, offer: 'DT2.OFERTA', timeoutMs: 5000 });
    assert.deepEqual(out, { answer: 'DT2.RESPOSTA', extra: { room: '123456' } });
    assert.deepEqual(seen, ['DT2.OFERTA']);
    await host.result;
    const keys = await R.deriveKeys(code);
    const raw = [...relay.messages(keys.toHost), ...relay.messages(keys.toGuest)].join('|');
    assert.equal(raw.includes('OFERTA') || raw.includes('RESPOSTA') || raw.includes('123456'), false, 'nada em claro no relé');
  });
});

test('uso único: depois do primeiro pareamento o código não aceita outro convidado', async () => {
  await withRelay(async (relay, client) => {
    const code = R.newCode();
    let calls = 0;
    const host = R.hostListen({ code, relay: client, respond: async () => { calls++; return { answer: 'DT2.A' }; } });
    await new Promise((r) => setTimeout(r, 50));
    await R.guestPair({ code, relay: client, offer: 'DT2.UM', timeoutMs: 5000 });
    await host.result;
    await assert.rejects(() => R.guestPair({ code, relay: client, offer: 'DT2.DOIS', timeoutMs: 600 }), /não respondeu/);
    assert.equal(calls, 1);
  });
});

test('código errado, ou Host que não escuta, não pareia; oferta vencida é ignorada pelo Host', async () => {
  await withRelay(async (relay, client) => {
    const code = 'K7QM-93XP';
    let called = false;
    const host = R.hostListen({ code, relay: client, respond: async () => { called = true; return { answer: 'DT2.A' }; } });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(() => R.guestPair({ code: 'K7QM-93XQ', relay: client, offer: 'DT2.X', timeoutMs: 500 }), /não respondeu/);
    assert.equal(called, false);
    // oferta com validade vencida (relógio do convidado adiantado/atrasado): o Host ignora
    await assert.rejects(() => R.guestPair({ code, relay: client, offer: 'DT2.VELHA', timeoutMs: 500, now: () => Date.now() - 2 * R.TTL_MS }), /não respondeu/);
    assert.equal(called, false);
    host.stop();
    await host.result;
    await assert.rejects(() => R.guestPair({ code: 'AAAA-BBBB', relay: client, offer: 'DT2.X', timeoutMs: 400 }), /não respondeu/);
  });
});

test('o relé precisa ser https (ou loopback em teste)', () => {
  assert.throws(() => new R.Relay({ baseUrl: 'http://ntfy.example.com' }), /https/);
  assert.doesNotThrow(() => new R.Relay({ baseUrl: 'https://ntfy.sh' }));
  assert.doesNotThrow(() => new R.Relay({ baseUrl: 'http://127.0.0.1:8899' }));
});
