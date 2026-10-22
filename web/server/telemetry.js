/* Estatísticas anônimas de uso (OPCIONAIS). Só enviam algo se (1) esta versão tem um endereço configurado em
   stats-config.json e (2) a pessoa permitiu. Sem permissão não há identificador, não há envio e não há fila.
   O que vai: um número aleatório da instalação, versão, sistema, se está em sala ou em chamada, e eventos contados
   (sala criada, chamada iniciada/encerrada em faixas de duração, tipo de rota, falha de voz). Nada de nome, do que a pessoa
   assiste, de conversa ou de endereço IP. `describe()` mostra exatamente isso na interface. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoTelemetry = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONSENT_KEY = 'duotela-telemetry';          // 'on' | 'off' | ausente (ainda não perguntou)
  const ID_KEY = 'duotela-install-id';
  const CONSENT_VER_KEY = 'duotela-telemetry-v';
  const CONSENT_VERSION = 2;                        // sobe quando o que é enviado muda: quem tinha aceitado a versão anterior é perguntado de novo
  const PING_EVERY_MS = 120000;                     // o painel considera "agora" quem avisou nos últimos 5 minutos
  const FLUSH_MS = 1500;
  const MAX_QUEUE = 20;

  const durationBucket = (ms) => (ms < 5 * 60000 ? '<5m' : ms < 30 * 60000 ? '5-30m' : ms < 2 * 3600000 ? '30m-2h' : '>2h');
  const connectBucket = (ms) => (ms < 3000 ? '<3s' : ms < 10000 ? '3-10s' : '>10s');
  /** Faixa de qualidade a partir de perda (%), jitter (ms) e atraso (ms); sem dados, nada é enviado. */
  const qualityBand = ({ lossPct, jitterMs, rttMs }) => {
    if (![lossPct, jitterMs].every(Number.isFinite)) return null;
    const rtt = Number.isFinite(rttMs) ? rttMs : 0;
    if (lossPct > 8 || jitterMs > 80 || rtt > 400) return 'poor';
    if (lossPct < 2 && jitterMs < 30 && rtt < 150) return 'good';
    return 'fair';
  };
  const osOf = (nav) => { const s = String((nav && (nav.userAgentData?.platform || nav.platform)) || '') + ' ' + String((nav && nav.userAgent) || ''); return /win/i.test(s) ? 'win' : /mac/i.test(s) ? 'mac' : /linux|x11/i.test(s) ? 'linux' : 'other'; };
  const validUrl = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(x.hostname))) && !x.username && !x.password && !x.search && !x.hash; } catch { return false; } };
  const newId = (crypto) => { const b = crypto.getRandomValues(new Uint8Array(16)); let s = ''; for (const n of b) s += String.fromCharCode(n); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

  class Telemetry {
    constructor({ getState, env = typeof window !== 'undefined' ? window : {}, fetchImpl, setTimer, clearTimer } = {}) {
      this.getState = typeof getState === 'function' ? getState : () => 'idle';
      this.env = env;
      this.fetch = fetchImpl || (env.fetch ? env.fetch.bind(env) : null);
      this.setTimer = setTimer || ((fn, ms) => env.setTimeout(fn, ms));
      this.clearTimer = clearTimer || ((t) => env.clearTimeout(t));
      this.config = { url: '', version: 'dev' };
      this.queue = []; this.timer = null; this.flushTimer = null; this.running = false;
      this.lastPayload = null; this.lastError = null; this.sent = 0;
    }

    storage() { try { return this.env.localStorage || null; } catch { return null; } }
    get(key) { try { return this.storage()?.getItem(key) ?? null; } catch { return null; } }
    set(key, v) { try { this.storage()?.setItem(key, v); } catch { /* sem armazenamento */ } }
    del(key) { try { this.storage()?.removeItem(key); } catch { /* idem */ } }

    async loadConfig() {
      try {
        const res = await this.fetch('/stats-config.json', { cache: 'no-store', credentials: 'omit' });
        const c = res.ok ? await res.json() : null;
        if (c && typeof c === 'object') this.config = { url: typeof c.url === 'string' ? c.url.replace(/\/+$/, '') : '', version: typeof c.version === 'string' && /^[0-9A-Za-z.+-]{1,20}$/.test(c.version) ? c.version : 'dev' };
      } catch { /* sem configuração: desativado */ }
      return this.config;
    }
    /** Esta versão tem um serviço de estatísticas configurado? Sem isso, nada é perguntado nem enviado. */
    get available() { return validUrl(this.config.url) && !!this.fetch; }
    // 'off' vale sempre (não insistimos); 'on' só vale para a versão do texto que a pessoa viu
    get consent() { const v = this.get(CONSENT_KEY); if (v === 'off') return 'off'; return v === 'on' && this.get(CONSENT_VER_KEY) === String(CONSENT_VERSION) ? 'on' : null; }
    get enabled() { return this.available && this.consent === 'on'; }

    setConsent(value) {
      if (value === 'on') {
        this.set(CONSENT_KEY, 'on'); this.set(CONSENT_VER_KEY, String(CONSENT_VERSION));
        if (this.available && !this.get(ID_KEY) && this.env.crypto?.getRandomValues) this.set(ID_KEY, newId(this.env.crypto));   // sem serviço configurado não existe identificador
        this.start();
      } else {
        this.set(CONSENT_KEY, 'off');
        this.del(ID_KEY);                           // ao recusar, o identificador deixa de existir
        this.stop();
        this.queue = [];
      }
    }

    buildPayload(ev) {
      const id = this.get(ID_KEY);
      if (!id) return null;
      const p = { v: 1, id, app: this.config.version, os: osOf(this.env.navigator), state: ['idle', 'room', 'call'].includes(this.getState()) ? this.getState() : 'idle' };
      if (ev) p.ev = ev.k ? { n: ev.n, k: ev.k } : { n: ev.n };
      return p;
    }

    /** Conta um evento (ex.: 'room_created', 'call_ended' com faixa). Ignorado sem permissão. */
    event(name, key) {
      if (!this.enabled) return;
      if (this.queue.length < MAX_QUEUE) this.queue.push({ n: name, k: key || '' });
      if (!this.flushTimer) this.flushTimer = this.setTimer(() => { this.flushTimer = null; void this.flush(); }, FLUSH_MS);
    }
    /** Envia o evento mais antigo da fila (ou só o aviso de presença). */
    async flush() {
      if (!this.enabled) return;
      const ev = this.queue.shift();
      const payload = this.buildPayload(ev);
      if (!payload) return;
      this.lastPayload = payload;
      try {
        const res = await this.fetch(this.config.url + '/v1/ping', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true });
        if (res && res.ok === false) throw new Error('HTTP ' + res.status);
        this.sent++; this.lastError = null;
      } catch (e) { this.lastError = String(e && e.message || e).slice(0, 80); if (ev && this.queue.length < MAX_QUEUE) this.queue.unshift(ev); }
      if (this.queue.length && !this.flushTimer) this.flushTimer = this.setTimer(() => { this.flushTimer = null; void this.flush(); }, FLUSH_MS);
    }

    start() {
      if (this.running || !this.enabled) return;
      this.running = true;
      void this.flush();
      const loop = () => { if (!this.running) return; void this.flush(); this.timer = this.setTimer(loop, PING_EVERY_MS); };
      this.timer = this.setTimer(loop, PING_EVERY_MS);
    }
    stop() { this.running = false; if (this.timer) this.clearTimer(this.timer); if (this.flushTimer) this.clearTimer(this.flushTimer); this.timer = null; this.flushTimer = null; }

    /** Texto para a interface: o que é enviado, para onde, e o último envio. */
    describe() {
      let host = ''; try { host = new URL(this.config.url).host; } catch { /* sem endereço */ }
      return { available: this.available, consent: this.consent, host, everyMinutes: PING_EVERY_MS / 60000, example: this.buildPayload({ n: 'call_ended', k: '5-30m' }) || { v: 1, id: '(criado só se você permitir)', app: this.config.version, os: osOf(this.env.navigator), state: 'idle', ev: { n: 'call_ended', k: '5-30m' } }, last: this.lastPayload, lastError: this.lastError, sent: this.sent };
    }
  }

  let shared = null;
  const getShared = () => shared || (shared = new Telemetry({}));   // uma só instância por página (boas-vindas, Perfil e a sala)

  return { Telemetry, shared: getShared, durationBucket, connectBucket, qualityBand, osOf, validUrl, CONSENT_KEY, ID_KEY, PING_EVERY_MS };
});
