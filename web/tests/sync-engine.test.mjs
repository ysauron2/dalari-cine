import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../src/sync-engine.mjs';

const CONTENT = { title: 'Mar de Inverno', episode: 1 };

function setup(overrides = {}, { rate = true, playError = null } = {}) {
  const clock = { t: 1000 };
  const log = [];
  const player = {
    time: 0, rates: [], calls: [], playError,
    getCurrentTime() { return this.time; },
    play() { this.calls.push('play'); return this.playError ? Promise.reject(this.playError) : Promise.resolve(); },
    pause() { this.calls.push('pause'); },
    seek(t) { this.calls.push(['seek', t]); this.time = t; },
  };
  if (rate) player.setPlaybackRate = function (r) { this.rates.push(r); };
  const engine = createSyncEngine({
    selfId: 'ana', content: CONTENT, player, now: () => clock.t, send: (m) => log.push(m), ...overrides,
  });
  return { engine, player, clock, log };
}

const remoteMsg = (type, seq, extra = {}) => ({
  type, seq, from: 'bia', title: CONTENT.title, episode: CONTENT.episode, ...extra,
});

test('mensagens sao serializaveis e carregam seq e origem crescentes', () => {
  const { engine, log } = setup();
  engine.localPlay();
  engine.localPause();
  assert.deepEqual(JSON.parse(JSON.stringify(log)), log);
  assert.deepEqual(log.map((m) => [m.type, m.seq, m.from]), [['play', 0, 'ana'], ['pause', 1, 'ana']]);
});

test('descarta duplicadas e fora de ordem', async () => {
  const { engine, player } = setup();
  assert.equal((await engine.receive(remoteMsg('seek', 5, { time: 10, playing: false }))).status, 'applied');
  const dup = await engine.receive(remoteMsg('seek', 5, { time: 99, playing: false }));
  const old = await engine.receive(remoteMsg('seek', 3, { time: 77, playing: false }));
  assert.deepEqual([dup.status, dup.reason], ['dropped', 'duplicate-or-old']);
  assert.equal(old.status, 'dropped');
  assert.equal(player.time, 10);
});

test('bloqueia comandos de titulo ou episodio diferente', async () => {
  const { engine, player } = setup();
  const t = await engine.receive(remoteMsg('play', 0, { time: 5, playing: true, title: 'Outro Horizonte' }));
  const e = await engine.receive(remoteMsg('play', 1, { time: 5, playing: true, episode: 2 }));
  assert.deepEqual([t.status, t.reason], ['blocked', 'content-mismatch']);
  assert.equal(e.status, 'blocked');
  assert.deepEqual(player.calls, []);
});

test('rejeita mensagens invalidas, proprias e de terceiro participante', async () => {
  const { engine } = setup();
  assert.equal((await engine.receive('{nao json')).status, 'invalid');
  assert.equal((await engine.receive({ type: 'play', seq: 0, from: 'bia' })).status, 'invalid');
  assert.equal((await engine.receive(remoteMsg('seek', -1, { time: 1, playing: false }))).status, 'invalid');
  assert.equal((await engine.receive({ ...remoteMsg('seek', 0, { time: 1, playing: false }), from: 'ana' })).reason, 'self');
  await engine.receive(remoteMsg('seek', 0, { time: 1, playing: false }));
  const third = await engine.receive({ ...remoteMsg('seek', 1, { time: 1, playing: false }), from: 'carla' });
  assert.equal(third.reason, 'unknown-peer');
});

test('play remoto bloqueado por gesto retorna pendente e resume depois', async () => {
  const err = Object.assign(new Error('gesture'), { name: 'NotAllowedError' });
  const { engine, player } = setup({}, { playError: err });
  const res = await engine.receive(remoteMsg('play', 0, { time: 20, playing: true }));
  assert.equal(res.status, 'pending');
  assert.equal(res.pending.reason, 'autoplay-blocked');
  assert.deepEqual(engine.getPending(), res.pending);
  assert.equal(engine.tick().reason, 'pending-play');

  player.playError = null; // usuario clicou
  const resumed = await engine.resumePending();
  assert.equal(resumed.status, 'applied');
  assert.equal(engine.getPending(), null);
  assert.equal(engine.tick().reason === 'pending-play', false);
});

test('pause remoto limpa play pendente; erro generico nao vira pendente', async () => {
  const err = Object.assign(new Error('x'), { name: 'NotAllowedError' });
  const a = setup({}, { playError: err });
  await a.engine.receive(remoteMsg('play', 0, { time: 1, playing: true }));
  assert.ok(a.engine.getPending());
  await a.engine.receive(remoteMsg('pause', 1, { time: 2, playing: false }));
  assert.equal(a.engine.getPending(), null);

  const b = setup({}, { playError: new Error('boom') });
  const res = await b.engine.receive(remoteMsg('play', 0, { time: 1, playing: true }));
  assert.deepEqual([res.status, res.error], ['error', 'boom']);
  assert.equal(b.engine.getPending(), null);
});

test('sem eco: acao remota nao gera mensagem de volta, acao local depois sim', async () => {
  const { engine, log } = setup();
  await engine.receive(remoteMsg('play', 0, { time: 5, playing: true }));
  // eventos do player causados pela acao remota
  assert.equal(engine.localSeek(), null);
  assert.equal(engine.localPlay(), null);
  assert.equal(log.length, 0);
  // acao do usuario depois e enviada
  assert.equal(engine.localPause().type, 'pause');
  assert.equal(engine.localPlay().type, 'play');
  assert.equal(log.length, 2);
});

test('eco expira fora da janela', async () => {
  const { engine, clock, log } = setup({ echoWindowMs: 500 });
  await engine.receive(remoteMsg('seek', 0, { time: 5, playing: false }));
  clock.t += 2000;
  assert.equal(engine.localSeek(7).type, 'seek');
  assert.equal(log.length, 1);
});

test('ping/pong mede latencia usando o menor rtt', async () => {
  const a = setup();
  const b = setup({ selfId: 'bia' });
  const ping = a.engine.ping();
  a.clock.t += 100;
  const { reply } = await b.engine.receive(ping);
  const r1 = await a.engine.receive(reply);
  assert.equal(r1.rtt, 100);
  const ping2 = a.engine.ping();
  a.clock.t += 40;
  await a.engine.receive((await b.engine.receive(ping2)).reply);
  assert.equal(a.engine.getLatency(), 0.02);
});

test('play remoto compensa a latencia medida', async () => {
  const { engine, player, clock } = setup();
  const p = engine.ping();
  clock.t += 200;
  await engine.receive({ type: 'pong', seq: 0, from: 'bia', t0: p.t0, tr: 0 });
  await engine.receive(remoteMsg('play', 1, { time: 10, playing: true }));
  assert.equal(player.time, 10.1);
});

// Local e remoto tocando; remoto em 10 s no instante t=1000.
async function playingWithRemote(opts, rateOpt) {
  const ctx = setup(opts, rateOpt);
  await ctx.engine.receive(remoteMsg('play', 0, { time: 10, playing: true }));
  ctx.player.calls.length = 0;
  return ctx;
}

test('deriva pequena: nenhuma acao', async () => {
  const { engine, player, clock } = await playingWithRemote();
  clock.t += 1000; player.time = 11.2; // remoto em 11, local +0.2 < 0.3
  assert.equal(engine.tick().action, 'none');
  assert.deepEqual(player.calls, []);
  assert.deepEqual(player.rates, []);
});

test('deriva media: ajusta playbackRate e restaura ao convergir', async () => {
  const { engine, player, clock } = await playingWithRemote();
  clock.t += 1000; player.time = 11.8; // remoto 11, local 0.8 a frente
  let r = engine.tick();
  assert.equal(r.action, 'rate');
  assert.equal(r.rate, 0.95);
  assert.deepEqual(player.calls, []); // sem seek

  clock.t += 1000; player.time = 12.2; // remoto 12; 0.2 ainda > tolerance/2: mantem
  assert.equal(engine.tick().action, 'rate');
  clock.t += 1000; player.time = 13.05; // remoto 13; convergiu
  r = engine.tick();
  assert.equal(r.action, 'rate-restored');
  assert.equal(player.rates.at(-1), 1);
  assert.equal(engine.tick().action, 'none');
});

test('deriva media com local atras acelera', async () => {
  const { engine, player, clock } = await playingWithRemote();
  clock.t += 1000; player.time = 10.2; // remoto 11, atras 0.8
  assert.equal(engine.tick().rate, 1.05);
});

test('deriva grande: seek e velocidade normal', async () => {
  const { engine, player, clock } = await playingWithRemote();
  clock.t += 1000; player.time = 11.8;
  engine.tick(); // rate 0.95
  clock.t += 1000; player.time = 5; // remoto 12, 7 s de deriva
  const r = engine.tick();
  assert.equal(r.action, 'seek');
  assert.deepEqual(player.calls, [['seek', 12]]);
  assert.deepEqual(player.rates, [0.95, 1]);
  assert.equal(engine.localSeek(), null); // seek de correcao nao ecoa
});

test('sem setPlaybackRate, deriva media cai para seek', async () => {
  const { engine, player, clock } = await playingWithRemote({}, { rate: false });
  clock.t += 1000; player.time = 11.8;
  assert.equal(engine.tick().action, 'seek');
});

test('tolerancia configuravel e validacao de opcoes', async () => {
  const { engine, player, clock } = await playingWithRemote({ tolerance: 1, seekThreshold: 3 });
  clock.t += 1000; player.time = 11.8;
  assert.equal(engine.tick().action, 'none');
  assert.throws(() => setup({ tolerance: 2, seekThreshold: 1 }), RangeError);
});

test('state remoto sincroniza play/pause e posicao', async () => {
  const { engine, player } = setup();
  await engine.receive(remoteMsg('state', 0, { time: 30, playing: true }));
  assert.deepEqual(player.calls, [['seek', 30], 'play']);
  const r = await engine.receive(remoteMsg('state', 1, { time: 40, playing: false }));
  assert.equal(r.status, 'applied');
  assert.equal(player.calls.at(-2), 'pause');
  assert.deepEqual(player.calls.at(-1), ['seek', 40]);
});
