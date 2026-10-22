/* Cliente headless do serviço de sala do Dalari Cine (fetch nativo; funciona no Node 24 e em navegadores).
   O papel vem do servidor (credencial emitida na criação/entrada), nunca de parâmetro do chamador.
   A credencial fica em campo privado: não aparece em JSON.stringify, util.inspect nem em erros.
   Este módulo NÃO grava nada em localStorage; quem reabrir uma sessão deve guardar a credencial por
   conta própria (recomendado: só em memória). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DuoRoomClient = api.DuoRoomClient; root.DuoRoomError = api.RoomError; }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const util = typeof require === 'function' ? require('node:util') : null;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

class RoomError extends Error {
  constructor(status, code) { super(code); this.name = 'RoomError'; this.status = status; this.code = code; }
}

class DuoRoomClient {
  #base; #fetch; #token = null; #role = null; #code = null;
  #seq = 0; #queue = Promise.resolve(); #revision = 0; #running = false; #abort = null; #snapshot = null;

  constructor({ serviceUrl, allowInsecure = false, fetchImpl } = {}) {
    const u = new URL(serviceUrl);
    if (u.search || u.hash || u.username || u.password) throw new Error('serviceUrl não pode ter query, fragmento ou credenciais.');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (LOOPBACK.has(u.hostname) || allowInsecure))) {
      throw new Error('Use https://. HTTP só é aceito em loopback (ou allowInsecure explícito, sem segurança).');
    }
    this.#base = u.origin;
    // Em navegadores, fetch nativo exige o contexto de Window. Chamá-lo como
    // propriedade privada deste cliente provoca "Illegal invocation".
    this.#fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.insecureTransport = u.protocol !== 'https:';
  }

  get role() { return this.#role; }
  get code() { return this.#code; }
  get snapshot() { return this.#snapshot; }
  get revision() { return this.#revision; }
  toJSON() { return { role: this.#role, code: this.#code, revision: this.#revision, insecureTransport: this.insecureTransport }; }
  [util ? util.inspect.custom : Symbol.for('nodejs.util.inspect.custom')]() { return `DuoRoomClient ${JSON.stringify(this.toJSON())}`; }

  static encodeInvite(code, inviteSecret) { return `${code}.${inviteSecret}`; }
  static decodeInvite(text) {
    const m = /^(\d{6})\.([A-Za-z0-9_-]{43})$/.exec(String(text).trim());
    if (!m) throw new Error('Convite malformado.');
    return { code: m[1], inviteSecret: m[2] };
  }

  /** Contadores simples para o painel de estatísticas; não afetam o funcionamento. */
  metrics = { calls: 0, errors: 0, lastMs: 0, avgMs: 0, maxMs: 0, polls: 0, lastPollMs: 0, lastError: null };
  #record(ms, poll, error) {
    const m = this.metrics;
    if (poll) { m.polls++; m.lastPollMs = ms; }
    else { m.calls++; m.lastMs = ms; m.avgMs = m.avgMs + (ms - m.avgMs) / m.calls; m.maxMs = Math.max(m.maxMs, ms); }
    if (error && error.name !== 'AbortError') { m.errors++; m.lastError = String(error.code || error.message || 'erro').slice(0, 40); }
  }
  async #call(method, path, body, opts) {
    const t0 = Date.now(), poll = path.includes('/state?');
    try { const d = await this.#callRaw(method, path, body, opts); this.#record(Date.now() - t0, poll, null); return d; }
    catch (e) { this.#record(Date.now() - t0, poll, e); throw e; }
  }

  async #callRaw(method, path, body, { auth = true, signal } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.#token) throw new Error('Sem sessão.');
      headers.Authorization = 'Bearer ' + this.#token;
    }
    const res = await this.#fetch(this.#base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    let data = null;
    try { data = await res.json(); } catch (e) { /* corpo inválido */ }
    if (!res.ok || !data || data.ok !== true) throw new RoomError(res.status, data && typeof data.error === 'string' ? data.error : 'bad_response');
    return data;
  }

  /** Cria a sala; este cliente vira Host. Devolve o convite (segredo de uso único) para mostrar ao Host. */
  async createRoom(displayName, { maxParticipants } = {}) {
    const body = {};
    if (displayName) body.displayName = displayName;
    if (maxParticipants !== undefined) body.maxParticipants = maxParticipants;
    const d = await this.#call('POST', '/v1/rooms', body, { auth: false });
    this.#token = d.hostToken; this.#role = 'host'; this.#code = d.code;
    return { code: d.code, invite: DuoRoomClient.encodeInvite(d.code, d.inviteSecret), inviteExpiresAt: d.inviteExpiresAt, roomExpiresAt: d.roomExpiresAt };
  }

  /** Pede entrada com o convite; fica pendente até o Host aprovar. */
  async joinRoom(invite, displayName) {
    const { code, inviteSecret } = DuoRoomClient.decodeInvite(invite);
    const d = await this.#call('POST', `/v1/rooms/${code}/join`, displayName ? { inviteSecret, displayName } : { inviteSecret }, { auth: false });
    this.#token = d.guestToken; this.#role = d.role; this.#code = d.code;
    return { status: d.status };
  }

  /** Reabre uma sessão com credencial guardada pelo chamador (reconexão após recarregar). */
  resume({ code, role, token, lastSeq = 0 }) {
    if (!/^\d{6}$/.test(code) || !['host', 'guest', 'guest2', 'guest3'].includes(role) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Sessão inválida.');
    this.#code = code; this.#role = role; this.#token = token; this.#seq = lastSeq; this.#revision = 0;
  }
  /** Exporta a credencial de propósito, só quando o chamador pede. Não use localStorage. */
  exportSession() { return { code: this.#code, role: this.#role, token: this.#token, lastSeq: this.#seq }; }

  /** participant é opcional só quando há exatamente um candidato (fluxo de dupla); com vários, informe o id. */
  admission(decision, participant) { return this.#call('POST', `/v1/rooms/${this.#code}/admission`, participant ? { decision, participant } : { decision }); }
  approveGuest(participant) { return this.admission('approve', participant); }
  denyGuest(participant) { return this.admission('deny', participant); }
  removeGuest(participant) { return this.admission('remove', participant); }
  /** Convidado aprovado ou pendente sai da sala (o Host usa closeRoom). */
  async leaveRoom() { this.stop(); return this.#call('POST', `/v1/rooms/${this.#code}/leave`, {}); }
  async setDisplayName(displayName) {
    const d = await this.#call('POST', `/v1/rooms/${this.#code}/profile`, { displayName });
    this.#adopt(d.snapshot);
    return this.#snapshot;
  }
  async newInvite() {
    const d = await this.#call('POST', `/v1/rooms/${this.#code}/invite`, {});
    return { invite: DuoRoomClient.encodeInvite(this.#code, d.inviteSecret), inviteExpiresAt: d.inviteExpiresAt };
  }
  async closeRoom() { this.stop(); return this.#call('POST', `/v1/rooms/${this.#code}/close`, {}); }

  /** Uma consulta de estado. wait>0 = long polling. Devolve snapshot ou null se nada mudou. */
  async getState({ after = this.#revision, wait = 0, signal } = {}) {
    const d = await this.#call('GET', `/v1/rooms/${this.#code}/state?after=${after}&wait=${wait}`, undefined, { signal });
    if (!d.changed) return null;
    this.#adopt(d.snapshot);
    return this.#snapshot; // uma resposta atrasada não regride a interface
  }

  #adopt(snap) {
    if (!snap || snap.v !== 1 || snap.code !== this.#code || snap.you !== this.#role || !Number.isInteger(snap.revision) || snap.revision < 1) {
      throw new Error('Snapshot da sala inconsistente.');
    }
    if (snap.revision >= this.#revision) { this.#revision = snap.revision; this.#snapshot = snap; }
    if (typeof snap.yourLastSeq === 'number' && snap.yourLastSeq > this.#seq) this.#seq = snap.yourLastSeq;
  }

  /** Envia uma ação em série. clientSeq é do cliente; falha de rede reenvia com o MESMO seq (idempotente). */
  send(type, payload) {
    const run = async () => {
      const seq = this.#seq + 1;
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const d = await this.#call('POST', `/v1/rooms/${this.#code}/actions`, { v: 1, clientSeq: seq, type, payload });
          this.#seq = seq; this.#adopt(d.snapshot);
          return d;
        } catch (e) {
          if (e instanceof RoomError) throw e;      // rejeição do servidor: não consome seq
          lastErr = e;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
      throw lastErr;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }
  startRound(mode) { return this.send('round.start', { mode }); }
  selectPlatform(platform) { return this.send('platform.select', { platform }); }
  async searchYouTube(query) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 80) throw new Error('Digite de 2 a 80 caracteres.');
    const d = await this.#call('GET', `/v1/rooms/${this.#code}/youtube/search?q=${encodeURIComponent(query.trim())}`);
    return d.results;
  }
  /** STUN/TURN para a voz, entregues só a quem está autenticado na sala (podem conter credencial TURN temporária). */
  async iceServers() {
    const d = await this.#call('GET', `/v1/rooms/${this.#code}/ice`);
    return Array.isArray(d.iceServers) ? d.iceServers : [];
  }
  pickManually(titleId) { return this.send('round.manual', { titleId }); }
  vote(titleId, vote) {
    if (!this.#snapshot || !this.#snapshot.round) return Promise.reject(new Error('Sem rodada.'));
    return this.send('vote', { round: this.#snapshot.round.roundNumber, titleId, vote });
  }
  selectYouTubeVideo(titleId, videoId) { return this.send('media.youtube', { titleId, videoId }); }
  openYouTubeVideo(videoId, title) { return this.send('video.open', { videoId, title }); }
  selectNetflixTitle(titleId, watchId) { return this.send('media.netflix', { titleId, watchId }); }
  playbackNetflix(titleId, watchId, action, positionSec) { return this.send('playback.netflix', { titleId, watchId, action, positionSec }); }
  voiceReady(ready) { return this.send('voice.ready', { ready }); }
  voiceRetry() { return this.send('voice.retry', {}); }
  voiceOffer(session, sdp, to) { return this.send('voice.offer', to ? { session, sdp, to } : { session, sdp }); }
  voiceAnswer(session, sdp, to) { return this.send('voice.answer', to ? { session, sdp, to } : { session, sdp }); }
  playback(titleId, action, positionSec) {
    const videoId = this.#snapshot?.media?.videoId;
    if (!videoId || this.#snapshot.media.titleId !== titleId) return Promise.reject(new Error('Selecione um vídeo do YouTube primeiro.'));
    return this.send('playback', { titleId, videoId, action, positionSec });
  }
  setViewing(titleId, { progress, rating = 0, listed = false }) { return this.send('viewing', { titleId, progress, rating, listed }); }

  /** Laço de long polling com reconexão. Termina em 401/403/409/410 (sessão perdida ou encerrada). */
  start({ onSnapshot, onStatus, waitSec = 20 } = {}) {
    if (this.#running) return;
    this.#running = true;
    const status = (s, detail) => { if (onStatus) onStatus(s, detail); };
    (async () => {
      let backoff = 500;
      status('connecting');
      while (this.#running) {
        this.#abort = new AbortController();
        try {
          const snap = await this.getState({ wait: waitSec, signal: this.#abort.signal });
          status('connected');
          backoff = 500;
          if (snap && onSnapshot) onSnapshot(snap);
          if (snap && ['closed', 'expired', 'guest_denied', 'guest_removed', 'guest_left'].includes(snap.status)) { this.#running = false; status('ended', snap.status); }
        } catch (e) {
          if (!this.#running) break;
          if (e instanceof RoomError && [400, 401, 403, 409, 410].includes(e.status)) {
            this.#running = false; status('ended', e.code); break;
          }
          status('reconnecting', e instanceof RoomError ? e.code : 'network');
          await new Promise((r) => setTimeout(r, backoff + Math.random() * 250));
          backoff = Math.min(backoff * 2, 8000);
        }
      }
    })();
  }
  stop() { this.#running = false; if (this.#abort) this.#abort.abort(); }
}

return { DuoRoomClient, RoomError };
});
