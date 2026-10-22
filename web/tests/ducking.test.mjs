import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Ducker, TIMING } = require('../server/ducking.js');

function rig(settings) {
  const clock = { t: 0 }, applied = [];
  const timers = new Set();
  const d = new Ducker({ apply: (g) => applied.push(Number(g.toFixed(3))), now: () => clock.t, setTimer: function () { if (this !== globalThis) throw new TypeError('Illegal invocation'); const id = Symbol('t'); timers.add(id); return id; },   // como o setInterval do navegador
    clearTimer: function (id) { if (this !== globalThis) throw new TypeError('Illegal invocation'); timers.delete(id); }, settings });
  const run = (ms) => { for (let i = 0; i < ms / TIMING.tickMs; i++) { clock.t += TIMING.tickMs; d.tick(); } };
  return { d, clock, applied, run, timers };
}

test('quando alguém fala o volume desce até o nível escolhido, rápido; ao parar, espera o resto e sobe devagar até 1', () => {
  const { d, applied, run, clock } = rig({ level: 0.4 });
  d.setSpeaking(true);
  run(TIMING.attackMs + 80);
  assert.equal(d.gain, 0.4);
  assert.ok(applied.every((g) => g >= 0.4 && g <= 1));
  assert.ok(applied.length >= 3, 'rampa suave, não um salto');
  d.setSpeaking(false);
  run(TIMING.holdMs - 80);                      // ainda no "resto": continua baixo
  assert.equal(d.gain, 0.4);
  run(80 + TIMING.releaseMs / 2);               // sobe pela metade
  assert.ok(d.gain > 0.4 && d.gain < 1);
  run(TIMING.releaseMs);
  assert.equal(d.gain, 1);
  assert.equal(applied.at(-1), 1);
});

test('pausa curta entre palavras não faz o volume pular (resto de 600 ms)', () => {
  const { d, run } = rig({ level: 0.3 });
  d.setSpeaking(true); run(400);
  d.setSpeaking(false); run(300);               // pausa menor que o resto
  d.setSpeaking(true); run(200);
  assert.equal(d.gain, 0.3);
});

test('desligado, ou nível 100%, não muda o volume; configurações inválidas são corrigidas', () => {
  const off = rig({ enabled: false });
  off.d.setSpeaking(true); off.run(600);
  assert.equal(off.d.gain, 1);
  const full = rig({ level: 1 });
  full.d.setSpeaking(true); full.run(600);
  assert.equal(full.d.gain, 1);
  const weird = rig({ level: 'abc' });
  assert.equal(weird.d.settings.level, 0.35);
  const zero = rig({ level: 0 });
  assert.equal(zero.d.settings.level, 0.05);   // nunca silencia o vídeo por completo
});

test('desligar o ducking no meio da fala devolve o volume; reset() restaura na hora e para o timer', () => {
  const { d, run, applied, timers } = rig({ level: 0.3 });
  d.setSpeaking(true); run(300);
  assert.equal(d.gain, 0.3);
  d.setSettings({ enabled: false });
  run(TIMING.releaseMs + 100);
  assert.equal(d.gain, 1);
  d.setSettings({ enabled: true }); d.setSpeaking(true); run(300);
  assert.equal(d.gain, 0.3);
  d.reset();
  assert.equal(d.gain, 1); assert.equal(applied.at(-1), 1); assert.equal(timers.size, 0);
});
