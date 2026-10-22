import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validatePing } from '../../stats-worker/src/index.js';
const require = createRequire(import.meta.url);
const { Telemetry, durationBucket, connectBucket, qualityBand, osOf, validUrl, CONSENT_KEY, ID_KEY, PING_EVERY_MS } = require('../server/telemetry.js');

function rig({ url = 'https://stats.example.workers.dev', version = '0.2.0', state = 'idle', ok = true } = {}) {
  const store = new Map(), calls = [], timers = new Map();
  let nextTimer = 1, clock = 0;
  const env = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } },
    navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
  };
  const fetchImpl = async (u, init) => {
    if (u === '/stats-config.json') return { ok: true, json: async () => ({ url, version }) };
    calls.push({ url: u, init }); if (!ok) throw new Error('rede'); return { ok: true };
  };
  const setTimer = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (ms) => { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); await t.fn(); } };
  const t = new Telemetry({ getState: () => state, env, fetchImpl, setTimer, clearTimer });
  return { t, store, calls, advance, setState: (s) => { state = s; }, timers };
}

test('sem endereço configurado ou sem permissão: nada é criado, perguntado nem enviado', async () => {
  const none = rig({ url: '' }); await none.t.loadConfig();
  assert.equal(none.t.available, false);
  none.t.setConsent('on');                                    // mesmo "permitindo", sem serviço configurado não há envio
  none.t.event('room_created'); await none.advance(5000);
  assert.equal(none.calls.length, 0); assert.equal(none.store.has(ID_KEY), false);
  const asked = rig(); await asked.t.loadConfig();
  assert.equal(asked.t.available, true); assert.equal(asked.t.consent, null);
  asked.t.event('room_created'); asked.t.start(); await asked.advance(PING_EVERY_MS * 3);
  assert.equal(asked.calls.length, 0, 'sem resposta do usuário não envia');
  assert.equal(asked.store.has(ID_KEY), false, 'nem cria identificador');
  asked.t.setConsent('off'); asked.t.event('call_started'); await asked.advance(PING_EVERY_MS * 2);
  assert.equal(asked.calls.length, 0); assert.equal(asked.store.get(CONSENT_KEY), 'off');
  assert.equal(validUrl('http://stats.example.com'), false); assert.equal(validUrl('https://u:p@x.com'), false); assert.equal(validUrl('https://x.com/?a=1'), false); assert.equal(validUrl('http://127.0.0.1:8790'), true);
});

test('com permissão: cria o identificador, avisa na hora e a cada 2 minutos, e o formato é aceito pelo Worker', async () => {
  const r = rig({ state: 'room' }); await r.t.loadConfig();
  r.t.setConsent('on');
  await r.advance(0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://stats.example.workers.dev/v1/ping');
  assert.equal(r.calls[0].init.credentials, 'omit'); assert.equal(r.calls[0].init.headers['Content-Type'], 'text/plain;charset=UTF-8');
  const p = JSON.parse(r.calls[0].init.body);
  assert.deepEqual(Object.keys(p).sort(), ['app', 'id', 'os', 'state', 'v']);
  assert.equal(p.os, 'win'); assert.equal(p.state, 'room'); assert.equal(p.app, '0.2.0');
  assert.ok(validatePing(p), 'o Worker aceita o aviso');
  r.setState('call'); await r.advance(PING_EVERY_MS);
  assert.equal(r.calls.length, 2); assert.equal(JSON.parse(r.calls[1].init.body).state, 'call');
  assert.equal(JSON.parse(r.calls[1].init.body).id, p.id, 'mesmo identificador');
});

test('eventos entram como contadores com chaves permitidas; todos passam na validação do Worker', async () => {
  const r = rig(); await r.t.loadConfig(); r.t.setConsent('on'); await r.advance(0);
  const before = r.calls.length;
  r.t.event('room_created'); r.t.event('call_started'); r.t.event('route', 'srflx'); r.t.event('call_ended', durationBucket(12 * 60000)); r.t.event('voice_failed');
  await r.advance(1500); await r.advance(1500); await r.advance(1500); await r.advance(1500); await r.advance(1500);
  const evs = r.calls.slice(before).map((c) => JSON.parse(c.init.body));
  assert.deepEqual(evs.map((e) => e.ev), [{ n: 'room_created' }, { n: 'call_started' }, { n: 'route', k: 'srflx' }, { n: 'call_ended', k: '5-30m' }, { n: 'voice_failed' }]);
  for (const e of evs) assert.ok(validatePing(e), JSON.stringify(e));
});

test('recusar apaga o identificador e para tudo; permitir de novo gera um identificador novo', async () => {
  const r = rig(); await r.t.loadConfig(); r.t.setConsent('on'); await r.advance(0);
  const id1 = r.store.get(ID_KEY); assert.ok(id1);
  r.t.setConsent('off');
  assert.equal(r.store.has(ID_KEY), false); assert.equal(r.timers.size, 0);
  const n = r.calls.length; await r.advance(PING_EVERY_MS * 3); assert.equal(r.calls.length, n);
  r.t.setConsent('on'); assert.notEqual(r.store.get(ID_KEY), undefined);
});

test('falha de rede não quebra nada: o evento volta para a fila e é reenviado', async () => {
  const r = rig({ ok: false }); await r.t.loadConfig(); r.t.setConsent('on'); await r.advance(0);
  r.t.event('room_created'); await r.advance(1500);
  assert.match(r.t.lastError, /rede/); assert.equal(r.t.queue.length >= 1, true);
  r.t.stop();
});

test('describe() mostra para onde vai e um exemplo exato; faixas de duração e sistema', () => {
  const r = rig();
  r.t.config = { url: 'https://stats.example.workers.dev', version: '0.2.0' };
  const d = r.t.describe();
  assert.equal(d.host, 'stats.example.workers.dev'); assert.equal(d.consent, null);
  assert.deepEqual(Object.keys(d.example).sort(), ['app', 'ev', 'id', 'os', 'state', 'v']);
  assert.deepEqual([60000, 10 * 60000, 40 * 60000, 3 * 3600000].map(durationBucket), ['<5m', '5-30m', '30m-2h', '>2h']);
  assert.equal(osOf({ platform: 'MacIntel', userAgent: '' }), 'mac'); assert.equal(osOf({ userAgentData: { platform: 'Linux' }, userAgent: '' }), 'linux'); assert.equal(osOf({ platform: 'iPhone', userAgent: 'x' }), 'other');
});

test('faixas de tempo para conectar e de qualidade; sem medida não há evento', () => {
  assert.deepEqual([500, 2999, 3000, 9999, 10000, 60000].map(connectBucket), ['<3s', '<3s', '3-10s', '3-10s', '>10s', '>10s']);
  assert.equal(qualityBand({ lossPct: 0.5, jitterMs: 12, rttMs: 60 }), 'good');
  assert.equal(qualityBand({ lossPct: 3, jitterMs: 12, rttMs: 60 }), 'fair');
  assert.equal(qualityBand({ lossPct: 0.5, jitterMs: 45, rttMs: 60 }), 'fair');
  assert.equal(qualityBand({ lossPct: 0.5, jitterMs: 12, rttMs: 200 }), 'fair');
  assert.equal(qualityBand({ lossPct: 9, jitterMs: 12, rttMs: 60 }), 'poor');
  assert.equal(qualityBand({ lossPct: 0.5, jitterMs: 90, rttMs: 60 }), 'poor');
  assert.equal(qualityBand({ lossPct: 0.5, jitterMs: 12, rttMs: 500 }), 'poor');
  assert.equal(qualityBand({ lossPct: 0.5, jitterMs: 12 }), 'good');
  assert.equal(qualityBand({ lossPct: NaN, jitterMs: 12, rttMs: 60 }), null);
});

test('consentimento versionado: quem aceitou o texto antigo é perguntado de novo e para de enviar; quem recusou continua recusado', async () => {
  const r = rig(); await r.t.loadConfig();
  r.store.set(CONSENT_KEY, 'on');                          // aceitou numa versão antiga (sem número de versão do texto)
  r.store.set(ID_KEY, 'AbCdEfGhIjKlMnOpQrSt12');
  assert.equal(r.t.consent, null); assert.equal(r.t.enabled, false);
  r.t.start(); r.t.event('room_created'); await r.advance(PING_EVERY_MS * 2);
  assert.equal(r.calls.length, 0, 'não envia sem aceitar o texto atual');
  r.t.setConsent('on'); assert.equal(r.t.consent, 'on');
  const off = rig(); await off.t.loadConfig(); off.store.set(CONSENT_KEY, 'off');
  assert.equal(off.t.consent, 'off');
});
