import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseVideoId, formatClock, create } = require('../server/youtube-player.js');

test('formata o relógio da barra de reprodução', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(155.9), '02:35');
  assert.equal(formatClock(3725), '1:02:05');
  for (const bad of [NaN, -4, undefined, Infinity]) assert.equal(formatClock(bad), '00:00');
});

test('aceita apenas ID ou link HTTPS real do YouTube', () => {
  assert.equal(parseVideoId('abcdefghijk'), 'abcdefghijk');
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=abcdefghijk&t=20'), 'abcdefghijk');
  assert.equal(parseVideoId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(parseVideoId('https://www.youtube.com/embed/abcdefghijk'), 'abcdefghijk');
  for (const url of ['http://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com.evil.example/watch?v=abcdefghijk',
    'javascript:alert(1)', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com.evil.example/watch?v=abcdefghijk']) {
    assert.equal(parseVideoId(url), null);
  }
});

test('bloqueio de autoplay pede gesto local sem mudar o estado compartilhado', async () => {
  const oldDocument = globalThis.document, oldYT = globalThis.YT, oldLocation = globalThis.location;
  let events, plays = 0;
  const element = () => ({
    classList: { add() {} }, hidden: false, isConnected: true, children: [],
    setAttribute() {}, addEventListener() {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  });
  globalThis.document = { createElement: element };
  globalThis.location = { origin: 'http://127.0.0.1' };
  globalThis.YT = {
    PlayerState: { PLAYING: 1, PAUSED: 2 },
    Player: class {
      constructor(_slot, config) { events = config.events; queueMicrotask(() => events.onReady()); }
      seekTo() {}
      playVideo() { plays++; }
      pauseVideo() {}
      getCurrentTime() { return 0; }
      destroy() {}
    },
  };
  try {
    const player = create(element());
    player.update({ status: 'active', media: { provider: 'youtube', videoId: 'abcdefghijk' }, playback: { state: 'playing', version: 1, positionSec: 0, updatedAt: Date.now() }, serverTime: Date.now() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(plays > 0);
    events.onAutoplayBlocked();
    assert.equal(player.needsLocalStart(), true);
    player.playLocal();
    assert.equal(player.needsLocalStart(), false);
    events.onStateChange({ data: globalThis.YT.PlayerState.PLAYING });
    assert.equal(player.needsLocalStart(), false);
    player.destroy();
  } finally {
    globalThis.document = oldDocument;
    globalThis.YT = oldYT;
    globalThis.location = oldLocation;
  }
});

test('ducking do player: guarda o volume da pessoa, abaixa proporcionalmente e devolve ao voltar a 1', async () => {
  const oldDocument = globalThis.document, oldYT = globalThis.YT, oldLocation = globalThis.location;
  let player, volume = 80;
  const element = () => ({ classList: { add() {} }, hidden: false, isConnected: true, children: [], setAttribute() {}, addEventListener() {}, append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; } });
  globalThis.document = { createElement: element };
  globalThis.location = { origin: 'http://127.0.0.1' };
  globalThis.YT = { PlayerState: { PLAYING: 1, PAUSED: 2 }, Player: class {
    constructor(_slot, config) { player = this; queueMicrotask(() => config.events.onReady()); }
    seekTo() {} playVideo() {} pauseVideo() {} getCurrentTime() { return 0; } destroy() {}
    getVolume() { return volume; } setVolume(v) { volume = v; }
  } };
  try {
    const p = create(element());
    p.duck(0.5); assert.equal(volume, 80);                      // sem player ainda: nada acontece
    p.update({ status: 'active', media: { provider: 'youtube', videoId: 'abcdefghijk' }, playback: { state: 'playing', version: 1, positionSec: 0, updatedAt: Date.now() }, serverTime: Date.now() });
    await new Promise((r) => setImmediate(r));
    p.duck(0.5); assert.equal(volume, 40);
    p.duck(0.25); assert.equal(volume, 20);                     // continua proporcional ao volume ORIGINAL (80), não ao já abaixado
    p.duck(1); assert.equal(volume, 80);
    p.duck(1); assert.equal(volume, 80);
    assert.ok(player);
  } finally { globalThis.document = oldDocument; globalThis.YT = oldYT; globalThis.location = oldLocation; }
});
