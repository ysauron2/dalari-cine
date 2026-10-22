/* Ducking: abaixa o volume do vídeo enquanto alguém fala na conversa e devolve quando a fala termina.
   A transição é suave (desce rápido, sobe devagar) e há um pequeno "resto" depois da fala para o volume não pular
   entre palavras. Este módulo só calcula o ganho (1 = volume normal); quem aplica ao player é o `apply(gain)`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoDucking = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = { enabled: true, level: 0.35 };           // level: fração do volume enquanto alguém fala
  const TIMING = { attackMs: 150, releaseMs: 700, holdMs: 600, tickMs: 40 };

  class Ducker {
    constructor({ apply, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval, settings } = {}) {
      this.apply = typeof apply === 'function' ? apply : () => {};
      this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
      this.settings = { ...DEFAULTS, ...(settings || {}) };
      this.gain = 1; this.sent = 1;
      this.speaking = false; this.lastSpeech = -Infinity; this.lastTick = null; this.timer = null;
      this.sanitize();
    }
    sanitize() {
      const l = Number(this.settings.level);
      this.settings.level = Number.isFinite(l) ? Math.max(0.05, Math.min(1, l)) : DEFAULTS.level;
      this.settings.enabled = this.settings.enabled !== false;
    }
    /** Chamado quando muda se há alguém falando (pessoas da conversa, sem contar você). */
    setSpeaking(on) {
      this.speaking = !!on;
      if (on) this.lastSpeech = this.now();
      this.start();
    }
    setSettings(next) { this.settings = { ...this.settings, ...next }; this.sanitize(); this.start(); }

    target() {
      const active = this.settings.enabled && (this.speaking || this.now() - this.lastSpeech < TIMING.holdMs);
      return active ? this.settings.level : 1;
    }
    start() {
      if (this.timer) return;
      this.lastTick = this.now();
      // setInterval/clearInterval do navegador exigem `this` = window: chamá-los como método do Ducker dá "Illegal invocation".
      this.timer = this.setTimer.call(globalThis, () => this.tick(), TIMING.tickMs);
    }
    stop() { if (this.timer) { this.clearTimer.call(globalThis, this.timer); this.timer = null; } }

    /** Um passo da rampa. Público para os testes. */
    tick() {
      const t = this.now(), dt = Math.max(0, t - (this.lastTick ?? t)); this.lastTick = t;
      if (this.speaking) this.lastSpeech = t;
      const target = this.target(), span = 1 - this.settings.level;
      const rate = span / (target < this.gain ? TIMING.attackMs : TIMING.releaseMs);
      if (target < this.gain) this.gain = Math.max(target, this.gain - rate * dt);
      else if (target > this.gain) this.gain = Math.min(target, this.gain + rate * dt);
      if (Math.abs(this.gain - this.sent) >= 0.005 || (this.gain === 1 && this.sent !== 1) || (this.gain === target && this.gain !== this.sent)) {
        this.sent = this.gain; this.apply(this.gain);
      }
      if (this.gain === target && !this.speaking && target === 1) this.stop();
    }
    /** Devolve o volume ao normal imediatamente (ao desligar a voz, por exemplo). */
    reset() { this.speaking = false; this.lastSpeech = -Infinity; this.gain = 1; this.stop(); if (this.sent !== 1) { this.sent = 1; this.apply(1); } }
  }

  return { Ducker, DEFAULTS, TIMING };
});
