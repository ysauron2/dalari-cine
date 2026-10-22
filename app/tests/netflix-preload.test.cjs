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
  const video = {
    paused: true, ended: false, currentTime: 10, volume: 0.35, audioLanguage: 'pt-BR', subtitleLanguage: 'en-US',
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    closest: () => null,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    async play() { this.paused = false; listeners.get('play')?.(); },
    pause() { this.paused = true; listeners.get('pause')?.(); },
  };
  const ipcRenderer = { on: (channel, fn) => handlers.set(channel, fn), send: (channel, value) => reports.push({ channel, value }) };
  const context = {
    require: () => ({ ipcRenderer }),
    location: { hostname: 'www.netflix.com', pathname: '/watch/123' },
    document: { querySelectorAll: () => [video] },
    setInterval: fn => { tick = fn; },
    Date: { now: () => now },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'netflix-preload.cjs'), 'utf8'), context);
  const state = (version, playback = {}) => ({ code: '123456', media: { titleId: 'tmdb:movie:1', watchId: '123' }, playback: { state: 'playing', positionSec: 20, updatedAt: 99000, version, ...playback }, serverTime: 100000 });
  return { video, reports, listeners, tick: () => tick(), send: value => handlers.get('duotela:netflix-state')(null, value), state, advance: ms => { now += ms; } };
}

test('Netflix integrada aplica play/pause/posição sem alterar áudio, legendas ou volume', async () => {
  const h = harness();
  h.tick();
  h.send(h.state(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.paused, false);
  assert.equal(h.video.currentTime, 21);
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
