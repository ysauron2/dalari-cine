'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const handlers = new Map();
  const reports = [];
  const listeners = new Map();
  let tick;
  let now = 100000;
  let position = 10, directWrites = 0, apiMissing = false;
  const calls = [];
  const video = {
    paused: true, ended: false, volume: 0.35, audioLanguage: 'pt-BR', subtitleLanguage: 'en-US',
    get currentTime() { return position; },
    set currentTime(v) { directWrites++; position = v; },       // atribuir direto é o que a Netflix rejeita (erro M7375): a busca tem de ir pelo player dela
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    closest: () => null,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    async play() { this.paused = false; listeners.get('play')?.(); },
    pause() { this.paused = true; listeners.get('pause')?.(); },
  };
  const ipcRenderer = { on: (channel, fn) => handlers.set(channel, fn), send: (channel, value) => reports.push({ channel, value }) };
  // webFrame de mentira: "roda" o código da página e imita o player interno da Netflix (seek em milissegundos)
  const webFrame = { executeJavaScript: async (code) => {
    calls.push(code);
    if (apiMissing) return false;
    const seek = /p\.seek\((\d+)\)/.exec(code);
    if (seek) { position = Number(seek[1]) / 1000; return true; }
    if (code.includes('p.play();')) { video.paused = false; listeners.get('play')?.(); return true; }
    if (code.includes('p.pause();')) { video.paused = true; listeners.get('pause')?.(); return true; }
    return code.includes('typeof p.seek');                    // sonda de saúde
  } };
  let healthTick = null, pageText = '';
  const timers = [];
  const context = {
    require: () => ({ ipcRenderer, webFrame }),
    location: { hostname: 'www.netflix.com', pathname: '/watch/123' },
    document: { querySelectorAll: () => [video], body: { get innerText() { return pageText; } } },
    setInterval: (fn, ms) => { if (ms === 700) tick = fn; else healthTick = fn; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => { timers.length = 0; },
    Date: { now: () => now },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'netflix-preload.cjs'), 'utf8'), context);
  const state = (version, playback = {}) => ({ code: '123456', media: { titleId: 'tmdb:movie:1', watchId: '123' }, playback: { state: 'playing', positionSec: 20, updatedAt: 99000, version, ...playback }, serverTime: 100000 });
  const hideVideo = () => { video.getBoundingClientRect = () => ({ width: 0, height: 0 }); };
  return { video, reports, listeners, calls, timers, hideVideo, setText: (t) => { pageText = t; }, health: () => healthTick(), directWrites: () => directWrites, noApi: () => { apiMissing = true; }, tick: () => tick(), send: value => handlers.get('duotela:netflix-state')(null, value), state, advance: ms => { now += ms; } };
}

test('Netflix integrada aplica play/pause/posição sem alterar áudio, legendas ou volume', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, false);
  assert.equal(h.video.currentTime, 21);
  h.advance(3000);                                                      // a Netflix bloqueia saltos muito seguidos: passa o intervalo mínimo
  h.send(h.state(2, { state: 'paused', positionSec: 42 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, true);
  assert.equal(h.video.currentTime, 42);
  assert.equal(h.video.volume, 0.35);
  assert.equal(h.video.audioLanguage, 'pt-BR');
  assert.equal(h.video.subtitleLanguage, 'en-US');
  assert.equal(h.reports.some(r => r.value.type === 'play' || r.value.type === 'pause' || r.value.type === 'seek'), false);
  h.advance(2000);
  await h.video.play();
  assert.equal(h.reports.at(-1).value.type, 'play');
});

test('Netflix integrada ignora título diferente e só relata o /watch/ atual', async () => {
  const h = harness();
  h.tick();
  const wrong = h.state(1); wrong.media.watchId = '999';
  h.send(wrong);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, true);
  h.advance(3000);
  await h.video.play();
  assert.equal(h.reports.some(r => r.value.type === 'play'), false);
  assert.equal(h.reports.every(r => r.value.watchId === '123'), true);
});

test('ducking da Netflix: abaixa proporcionalmente ao volume que a pessoa tinha, devolve ao voltar a 1 e ignora valores inválidos', () => {
  const vm2 = require('node:vm');
  const h = (() => {
    // reaproveita o harness: o preload registra o ouvinte do canal de ducking
    const handlers = new Map();
    const video = { paused: true, ended: false, currentTime: 0, volume: 0.5, getBoundingClientRect: () => ({ width: 1280, height: 720 }), closest: () => null, addEventListener() {}, removeEventListener() {} };
    const context = {
      require: () => ({ ipcRenderer: { on: (c, fn) => handlers.set(c, fn), send() {} } }),
      location: { hostname: 'www.netflix.com', pathname: '/watch/123' },
      document: { querySelectorAll: () => [video], querySelector: () => video },
      setInterval() {}, Date: { now: () => 1 },
    };
    vm2.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'netflix-preload.cjs'), 'utf8'), context);
    return { video, duck: gain => handlers.get('duotela:duck')(null, gain) };
  })();
  h.duck(0.4); assert.equal(h.video.volume, 0.2);
  h.duck(0.2); assert.equal(h.video.volume, 0.1);        // continua proporcional ao volume ORIGINAL (0,5)
  for (const bad of [2, -1, NaN, 'x', null, undefined]) { h.duck(bad); assert.equal(h.video.volume, 0.1, String(bad)); }
  h.duck(1); assert.equal(h.video.volume, 0.5);
  h.duck(1); assert.equal(h.video.volume, 0.5);
});

test('Sincronizar agora: a primeira vez que vê uma sincronização vai exatamente ao ponto combinado, mesmo dentro da folga de 2,5 s; depois volta ao normal', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1));                                                   // tocando, ~21 s
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.currentTime, 21);
  h.send(h.state(2, { state: 'paused', positionSec: 22.4, syncId: 1 })); // 1,4 s de diferença: sem syncId não mexeria
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, true);
  assert.equal(h.video.currentTime, 22.4);
  h.video.currentTime = 23.1;                                           // a pessoa mexeu um pouco durante a contagem
  h.send(h.state(3, { state: 'playing', positionSec: 22.4, syncId: 1, updatedAt: 100000 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, false);
  assert.equal(h.video.currentTime, 23.1, 'o mesmo syncId não força outro ajuste');
  h.send(h.state(4, { state: 'paused', positionSec: 30, syncId: 2 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.currentTime, 30, 'um syncId novo volta a forçar');
});

test('a busca no filme vai pelo player interno da Netflix e nunca atribui currentTime direto (isso causa o erro M7375)', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1));
  await new Promise(resolve => setImmediate(resolve));
  h.send(h.state(2, { state: 'paused', positionSec: 42, syncId: 1 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.currentTime, 42);
  assert.equal(h.directWrites(), 0, 'nenhuma atribuição direta a currentTime');
  assert.ok(h.calls.length >= 2 && h.calls.every(c => /getAPI\(\)\.videoPlayer/.test(c)));
  assert.ok(h.calls.some(c => /p\.seek\(42000\)/.test(c)), 'em milissegundos');
  assert.equal(h.reports.at(-1).value.status, 'applied');
});

test('play e pausa também vão pelo player da Netflix (o <video> só entra se o player não existir)', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1, { positionSec: 10 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, false);
  assert.ok(h.calls.some(c => c.includes('p.play();')), 'play pelo player');
  h.advance(3000);
  h.send(h.state(2, { state: 'paused', positionSec: 10 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, true);
  assert.ok(h.calls.some(c => c.includes('p.pause();')), 'pausa pelo player');
  assert.equal(h.directWrites(), 0);
});

test('buscas seguidas respeitam o intervalo mínimo: a segunda espera e aplica o estado mais recente', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.currentTime, 21);
  const seeks = () => h.calls.filter(c => /p\.seek\(\d+\)/.test(c)).length;
  assert.equal(seeks(), 1);
  h.send(h.state(2, { positionSec: 60 }));                              // logo em seguida: não busca de novo, agenda
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seeks(), 1, 'ainda dentro do intervalo');
  assert.equal(h.timers.length, 1, 'há uma tentativa agendada');
  assert.ok(h.timers[0].ms >= 2500 && h.timers[0].ms <= 2600);
  h.send(h.state(3, { positionSec: 90 }));                              // outro estado chega antes: substitui o agendamento
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.timers.length, 1);
  h.advance(2600);
  h.timers[0].fn();                                                      // o tempo passou: aplica o ESTADO MAIS RECENTE
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seeks(), 2);
  assert.equal(h.video.currentTime, 91, 'ponto do estado 3 (90 s + 1 s de atraso do servidor), não o do estado 2');
});

test('"Sincronizar agora" (syncId novo) não espera o intervalo', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1));
  await new Promise(resolve => setImmediate(resolve));
  h.send(h.state(2, { state: 'paused', positionSec: 50, syncId: 1 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.currentTime, 50);
  assert.equal(h.timers.length, 0);
});

test('sonda de saúde: avisa "api-ok", "api-missing" (só após dois testes seguidos) e o código de erro da página', async () => {
  const h = harness();
  h.tick();
  await h.health();
  assert.equal(h.reports.at(-1).value.status, 'api-ok');
  const n = h.reports.length;
  await h.health();
  assert.equal(h.reports.length, n, 'sem repetir o mesmo aviso');
  const m = harness();
  m.noApi(); m.tick();
  await m.health();
  assert.equal(m.reports.some(r => r.value.status === 'api-missing'), false, 'um teste só não basta');
  await m.health();
  assert.equal(m.reports.at(-1).value.status, 'api-missing');
  const e = harness();
  e.tick(); e.hideVideo(); e.setText('Desculpe pela interrupção. Estamos tendo problemas com sua solicitação. Código de erro M7375');
  await e.health(); await e.health();
  assert.equal(e.reports.at(-1).value.status, 'netflix-error:M7375');
  assert.equal(e.reports.filter(r => String(r.value.status).startsWith('netflix-error')).length, 1, 'avisa uma vez');
  const clean = harness();
  clean.tick(); clean.hideVideo(); clean.setText('Início  Séries  Filmes  Bombando 12345');
  await clean.health(); await clean.health();
  assert.equal(clean.reports.some(r => String(r.value.status).startsWith('netflix-error')), false, 'sem código de erro, sem aviso');
});

test('sem o player interno da Netflix: não força a posição, mantém play/pausa e avisa "seek-unavailable"', async () => {
  const h = harness();
  h.noApi();
  h.tick();
  h.send(h.state(1, { positionSec: 60 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.directWrites(), 0, 'sem plano B por atribuição direta');
  assert.equal(h.video.currentTime, 10, 'a posição não foi mexida');
  assert.equal(h.video.paused, false, 'o play continua valendo');
  assert.equal(h.reports.at(-1).value.status, 'seek-unavailable');
});

test('o código enviado à página leva só um número, limitado a 0..24 h', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1, { positionSec: 999999 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(c => /p\.seek\(86400000\)/.test(c)));
});
