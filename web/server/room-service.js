'use strict';
/* Serviço de sala do Dalari Cine (HTTP + long polling). Somente módulos nativos do Node.
   NÃO IMPLANTADO. HTTP puro não é seguro pela internet: produção exige HTTPS (TLS) em proxy
   reverso confiável, limite de taxa no proxy e revisão de segurança. Veja server/README.md.

   Credenciais: 256 bits aleatórios (crypto.randomBytes), enviadas só no cabeçalho
   Authorization: Bearer; o servidor guarda apenas SHA-256 delas. Nada de token em URL, log ou
   snapshot. O código de 6 dígitos é só localizador público. */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const MatchEngine = require('../src/match-engine.js');
const CATALOG = require('../src/catalog.js');
const PLATFORMS = Object.freeze({ youtube: 'YouTube grátis', netflix: 'Netflix', prime: 'Prime Video', crunchyroll: 'Crunchyroll' });

const PROTOCOL_VERSION = 1;
// Identidades estáveis por participante: 'host' + até três convidados. O papel vem da credencial.
const GUEST_SLOTS = ['guest', 'guest2', 'guest3'];
const ROLES = ['host', ...GUEST_SLOTS];
const TO_ENGINE = { host: 'you', guest: 'partner', guest2: 'p3', guest3: 'p4' };
const FROM_ENGINE = Object.fromEntries(Object.entries(TO_ENGINE).map(([k, v]) => [v, k]));
const MAX_PARTICIPANTS = 4;
const DEFAULT_CAPACITY = 2;     // compatível com o fluxo de dupla; a interface pede 4 explicitamente
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const NETFLIX_WATCH_ID_RE = /^[0-9]{1,12}$/;
const VOICE_SDP_LIMIT = 24000;
const FORBIDDEN_KEYS = ['role', 'from', 'sender', 'identity', 'who', 'user', 'host', 'guest', 'token', 'credential', 'participant'];

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  allowedOrigins: [],            // vazio: qualquer requisição com Origin é recusada
  allowNonLoopback: false,
  inviteTtlMs: 15 * 60 * 1000,
  pendingTtlMs: 5 * 60 * 1000,   // tempo para o Host aprovar/negar
  roomTtlMs: 4 * 60 * 60 * 1000,
  closedGraceMs: 60 * 1000,
  maxBodyBytes: 4096,
  maxRooms: 500,
  maxWaiters: 200,
  maxWaitSec: 25,
  presenceMs: 45 * 1000,
  countdownMs: 3500,             // "Sincronizar agora": pausa todos no mesmo ponto e dá play junto depois deste tempo (3, 2, 1)
  chatMax: 30,                   // mensagens que a sala guarda (só na memória, some quando a sala fecha)
  chatGapMs: 700,                // intervalo mínimo entre mensagens da mesma pessoa
  queueMax: 10,                  // vídeos na fila do YouTube
  breakMaxMs: 30 * 60000,        // o intervalo mais longo que a sala aceita (também o teto ao estender)
  lagTtlMs: 20000,               // um relato de atraso some sozinho depois disso (quem fechou o vídeo ou perdeu a conexão não fica "atrasado" para sempre)
  reactionGapMs: 600,           // intervalo mínimo entre reações da mesma pessoa
  rateLimits: { create: 10, join: 20, general: 600, youtubeSearch: 12 }, // por IP de socket e por minuto
  logger: null,                  // (evento) => void; só recebe método/rota-modelo/status
  servePrototype: false,         // serve a interface no mesmo origin durante desenvolvimento local
  youtubeApiKey: null,           // opcional; fica somente no processo Node
  iceServers: [],                // STUN/TURN estáticos para a voz: [{urls, username?, credential?}]
  statsOrigin: '',                   // origem do serviço de estatísticas anônimas (opcional); entra no connect-src da CSP
  relayOrigins: ['https://ntfy.sh'], // serviços de encontro (código curto) que a página pode contatar: entram no connect-src da CSP
  turn: null,                    // {urls, secret, ttlSec?}: credenciais TURN temporárias (REST/HMAC, coturn use-auth-secret)
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exactKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => has(o, k));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
const newSecret = () => crypto.randomBytes(32).toString('base64url');
const validDisplayName = (value) => typeof value === 'string' && value === value.trim() &&
  /^[\p{L}\p{M}\p{N} .'-]{2,32}$/u.test(value);

function hashMatches(candidate, storedHash) {
  // Sempre calcula o hash e compara em tempo constante; formato inválido não curto-circuita antes.
  const ok = typeof candidate === 'string' && TOKEN_RE.test(candidate);
  const h = sha256(ok ? candidate : '');
  return crypto.timingSafeEqual(h, storedHash) && ok;
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function createRoomService(userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts, rateLimits: { ...DEFAULTS.rateLimits, ...(userOpts.rateLimits || {}) } };
  const customCatalog = Array.isArray(opts.catalog) && opts.catalog.length > 0;
  const catalog = customCatalog ? opts.catalog : CATALOG;
  if (customCatalog) {
    for (const item of catalog) {
      const validId = typeof item?.id === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(item.id);
      const validImage = typeof item?.image === 'string' && (/^https:\/\/image\.tmdb\.org\/t\/p\/[a-z0-9]+\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(item.image) || /^assets\/[a-z0-9-]+\.(png|svg)$/i.test(item.image));
      const validLink = item?.tmdbUrl === undefined || (typeof item.tmdbUrl === 'string' && /^https:\/\/www\.themoviedb\.org\/(movie|tv)\/[1-9][0-9]*$/.test(item.tmdbUrl));
      const tmdbParts = /^tmdb:(movie|tv):([1-9][0-9]*)$/.exec(item?.id || '');
      const validWatch = opts.catalogSource !== 'tmdb' || (tmdbParts && Array.isArray(item.watchProviders) && item.watchProviders.length > 0 &&
        item.watchProviders.every((name) => ['Netflix', 'Prime Video', 'Crunchyroll', 'YouTube grátis'].includes(name)) &&
        item.watchUrl === `https://www.themoviedb.org/${tmdbParts[1]}/${tmdbParts[2]}/watch?locale=BR`);
      if (!validId || !validImage || !validLink || !validWatch) throw new TypeError('invalid_catalog_item');
    }
  }
  const titleIds = new Set(catalog.map((c) => c.id));
  const catalogSource = customCatalog && opts.catalogSource === 'tmdb' ? 'tmdb' : 'demo';
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  if (opts.youtubeApiKey !== null && opts.youtubeApiKey !== undefined && (typeof opts.youtubeApiKey !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(opts.youtubeApiKey))) throw new TypeError('invalid_youtube_api_key');
  const ICE_URL_RE = /^(?:stun|stuns|turn|turns):[A-Za-z0-9.\-[\]:]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/;
  const validIceUrls = (u) => (typeof u === 'string' ? [u] : Array.isArray(u) && u.length > 0 && u.length <= 8 ? u : null)?.every((x) => typeof x === 'string' && x.length <= 200 && ICE_URL_RE.test(x)) === true;
  if (!Array.isArray(opts.iceServers) || opts.iceServers.length > 8 || !opts.iceServers.every((s) => isPlain(s) && validIceUrls(s.urls) &&
    Object.keys(s).every((k) => ['urls', 'username', 'credential'].includes(k)) &&
    ['username', 'credential'].every((k) => s[k] === undefined || (typeof s[k] === 'string' && s[k].length <= 512)))) throw new TypeError('invalid_ice_servers');
  if (opts.turn !== null && !(isPlain(opts.turn) && validIceUrls(opts.turn.urls) && typeof opts.turn.secret === 'string' && opts.turn.secret.length >= 16 &&
    (opts.turn.ttlSec === undefined || Number.isFinite(opts.turn.ttlSec)))) throw new TypeError('invalid_turn_config');
  if (!Array.isArray(opts.relayOrigins) || opts.relayOrigins.length > 4 || !opts.relayOrigins.every((o) => typeof o === 'string' && /^(?:https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})$/i.test(o))) throw new TypeError('invalid_relay_origins');
  if (opts.statsOrigin !== '' && !(typeof opts.statsOrigin === 'string' && /^(?:https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})$/i.test(opts.statsOrigin))) throw new TypeError('invalid_stats_origin');
  const allowedOrigins = new Set(opts.allowedOrigins);
  const rooms = new Map();           // código -> sala
  const waiters = new Map();         // código -> { host?, guest? }
  let waiterCount = 0;
  const buckets = new Map();         // `${ip}|${kind}` -> { n, resetAt }
  const dummyHash = sha256('dummy');

  const log = (method, route, status) => { if (opts.logger) opts.logger({ method, route, status }); };

  // ---------- limite de taxa simples por IP do socket (o proxy deve fazer o definitivo) ----------
  function rateLimit(ip, kind) {
    const key = ip + '|' + kind, t = now();
    let b = buckets.get(key);
    if (!b || t >= b.resetAt) { b = { n: 0, resetAt: t + 60000 }; buckets.set(key, b); }
    if (++b.n > opts.rateLimits[kind]) throw new HttpError(429, 'rate_limited');
  }

  // ---------- salas ----------
  function allocateCode() {
    for (let i = 0; i < 30; i++) {
      const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      if (!rooms.has(c)) return c;
    }
    throw new HttpError(503, 'busy');
  }

  function newInvite(room) {
    const secret = newSecret();
    room.invite = { hash: sha256(secret), expiresAt: now() + opts.inviteTtlMs, consumed: false };
    return secret;
  }

  function bump(room) { room.revision += 1; notify(room); }

  // ---------- participantes ----------
  const LIVE = ['pending', 'approved'];
  const memberOf = (room, slot) => (slot === 'host' ? null : room.members[slot] || null);
  const approvedSlots = (room) => ['host', ...GUEST_SLOTS.filter((g) => room.members[g]?.state === 'approved')];
  const pendingSlots = (room) => GUEST_SLOTS.filter((g) => room.members[g]?.state === 'pending').sort((a, b) => room.members[a].requestedAt - room.members[b].requestedAt);
  const liveCount = (room) => 1 + GUEST_SLOTS.filter((g) => LIVE.includes(room.members[g]?.state)).length;
  const isApproved = (room, slot) => slot === 'host' || room.members[slot]?.state === 'approved';

  const pairKey = (a, b) => (ROLES.indexOf(a) < ROLES.indexOf(b) ? a + '|' + b : b + '|' + a);
  function pairOf(room, a, b) {
    const key = pairKey(a, b);
    if (!room.voice.pairs[key]) room.voice.pairs[key] = { session: 1, offer: null, answer: null };
    return room.voice.pairs[key];
  }
  /** Reinicia as ligações de voz de uma pessoa (mudou o microfone, saiu ou pediu nova tentativa). */
  function bumpPairsOf(room, slot) {
    for (const peer of ROLES) {
      if (peer === slot) continue;
      const p = pairOf(room, slot, peer);
      p.session += 1; p.offer = null; p.answer = null;
    }
  }

  /** A composição mudou (entrada, saída, remoção): nunca se contam votos de um conjunto antigo de pessoas.
      Antes do match a mesma seleção é reiniciada com votos limpos e um aviso explícito; depois do match
      o título já escolhido pelos participantes de então é mantido e a mudança fica registrada no aviso. */
  function compositionChanged(room, kind, slot) {
    const name = room.names[slot] || 'Convidado';
    const people = approvedSlots(room).map((r) => TO_ENGINE[r]);
    const matched = room.round && MatchEngine.resolveRound(room.round).status === 'match';
    if (room.round && !matched) {
      const why = kind === 'joined' ? name + ' entrou na sala' : kind === 'removed' ? name + ' foi removido(a) da sala' : name + ' saiu da sala';
      room.round = MatchEngine.restartRound(room.round, people, 'Rodada reiniciada: ' + why + '. Todos votam de novo.');
      room.notice = { kind: 'round_restarted', reason: kind, slot, name, at: now(), roundNumber: room.round.roundNumber };
    } else if (room.round && matched) {
      room.notice = { kind: kind === 'joined' ? 'joined_after_match' : 'left_after_match', reason: kind, slot, name, at: now(), roundNumber: room.round.roundNumber };
    }
  }

  // ---------- sincronizar agora (contagem) e reações ----------
  const REACTIONS = ['heart', 'laugh', 'wow', 'clap', 'cry', 'popcorn'];
  function cancelCountdown(room) {
    if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
    room.countdown = null;
  }
  /** Quando a contagem termina, o Host da sala (este serviço) muda o estado para "tocando" a partir do ponto combinado. */
  function runCountdown(room) {
    const c = room.countdown;
    if (!c || now() < c.startsAt) return false;
    const pb = room.playback;
    cancelCountdown(room);
    if (room.media && pb && pb.syncId === c.id) {   // se alguém mexeu no vídeo durante a contagem, não sobrescreve
      room.playback = { ...pb, state: 'playing', positionSec: c.positionSec, updatedBy: c.by, updatedAt: c.startsAt, version: pb.version + 1 };
    }
    bump(room);
    return true;
  }
  function scheduleCountdown(room) {
    if (room.countdownTimer) clearTimeout(room.countdownTimer);
    room.countdownTimer = setTimeout(() => { room.countdownTimer = null; if (rooms.get(room.code) === room) runCountdown(room); }, opts.countdownMs + 30);
    if (room.countdownTimer.unref) room.countdownTimer.unref();
  }

  // ---------- intervalo: pausa todos no mesmo ponto; no fim (ou em "Voltar agora") roda a contagem 3-2-1 e todos dão play juntos ----------
  function cancelBreak(room) {
    if (room.breakTimer) { clearTimeout(room.breakTimer); room.breakTimer = null; }
    room.breakInfo = null;
  }
  function scheduleBreak(room) {
    if (room.breakTimer) clearTimeout(room.breakTimer);
    room.breakTimer = setTimeout(() => { room.breakTimer = null; if (rooms.get(room.code) === room && room.breakInfo && now() >= room.breakInfo.endsAt) { endBreak(room, room.breakInfo.by); bump(room); } }, Math.max(0, room.breakInfo.endsAt - now()) + 30);
    if (room.breakTimer.unref) room.breakTimer.unref();
  }
  /** Fim do intervalo: sai do modo pausa e abre a mesma contagem de "Sincronizar agora", a partir do ponto em que pararam. */
  function endBreak(room, by) {
    const b = room.breakInfo;
    if (!b) return;
    cancelBreak(room);
    if (!room.media || !room.playback) return;
    const t = now();
    room.syncSeq += 1;
    room.countdown = { id: room.syncSeq, by, startsAt: t + opts.countdownMs, positionSec: b.positionSec };
    room.playback = { ...room.playback, state: 'paused', positionSec: b.positionSec, updatedBy: by, updatedAt: t, version: room.playback.version + 1, syncId: room.syncSeq };
    for (const r of ROLES) room.ready[r] = false;
    scheduleCountdown(room);
  }

  /** Aplica expirações de forma preguiçosa. */
  function tick(room) {
    const t = now();
    if (room.breakInfo && t >= room.breakInfo.endsAt) endBreak(room, room.breakInfo.by);
    if (room.countdown && t >= room.countdown.startsAt) runCountdown(room);
    if (room.status === 'open' && t >= room.expiresAt) { room.status = 'expired'; room.endedAt = t; bump(room); }
    if (room.status === 'open') {
      for (const g of GUEST_SLOTS) {
        const m = room.members[g];
        if (m && m.state === 'pending' && t - m.requestedAt >= opts.pendingTtlMs) { m.state = 'denied'; bump(room); }
      }
    }
  }

  function roomStatus(room) {
    if (room.status !== 'open') return room.status;               // 'closed' | 'expired'
    if (approvedSlots(room).length >= 2) return 'active';
    if (pendingSlots(room).length) return 'pending_approval';
    return 'waiting_guest';
  }

  function inviteState(room) {
    if (room.invite.consumed) return 'used';
    if (now() >= room.invite.expiresAt) return 'expired';
    return 'valid';
  }

  function legacySaved(room) {
    // Aproximação documentada: "you" é o Host e "partner" resume todos os convidados aprovados
    // (um veto de qualquer convidado vale; "gostei" só conta sem nenhum veto).
    const slots = approvedSlots(room);
    const guests = slots.filter((r) => r !== 'host');
    const saved = {};
    for (const id of titleIds) {
      const h = room.viewing.host[id];
      const gs = guests.map((g) => room.viewing[g][id]);
      if (!h && !gs.some(Boolean)) continue;
      const everyone = slots.map((r) => room.viewing[r][id]);
      const progress = everyone.every(Boolean) ? Math.min(...everyone.map((e) => e.progress)) : 0;
      const gr = gs.map((e) => (e ? e.rating : 0));
      const partner = gr.some((x) => x < 0) ? -1 : gr.some((x) => x > 0) ? 1 : 0;
      saved[id] = {
        progress,   // "assistido" só se todos chegaram lá
        listed: everyone.some((e) => e && e.listed),
        ratings: { you: h ? h.rating : 0, partner },
      };
    }
    return MatchEngine.sanitizeSaved(saved);
  }

  function publicRound(room) {
    const r = room.round;
    if (!r) return null;
    const people = MatchEngine.peopleOf(r);
    const votes = {};
    for (const p of people) votes[FROM_ENGINE[p]] = { ...r.votes[p] };
    const participants = people.map((p) => FROM_ENGINE[p]);
    return {
      roundNumber: r.roundNumber, source: r.source, picks: r.picks.slice(), neutral: r.neutral, summary: r.summary,
      participants, votes,
      late: approvedSlots(room).filter((slot) => !participants.includes(slot)),
      result: MatchEngine.resolveRound(r),
    };
  }

  /** Snapshot canônico para um participante. Nunca contém credenciais, hashes ou segredos de convite. */
  function snapshotFor(room, role) {
    const status = roomStatus(room);
    const me = memberOf(room, role);
    const snap = { v: PROTOCOL_VERSION, code: room.code, revision: room.revision, status, you: role, serverTime: now(), roomExpiresAt: room.expiresAt };
    if (me && (me.state === 'denied' || me.state === 'removed' || me.state === 'left')) {
      snap.status = 'guest_' + me.state; return snap;
    }
    if (me && me.state === 'pending') { snap.status = 'pending_approval'; return snap; }
    snap.capacity = room.capacity;
    const approved = approvedSlots(room);
    snap.names = { host: room.names.host, guest: room.names.guest };
    for (const r of approved) snap.names[r] = room.names[r];
    if (role === 'host') for (const g of pendingSlots(room)) snap.names[g] = room.names[g];
    snap.yourLastSeq = room.lastSeq[role];
    snap.presence = { host: now() - room.lastSeen.host < opts.presenceMs, guest: false };
    for (const r of approved) snap.presence[r] = now() - room.lastSeen[r] < opts.presenceMs;
    snap.participants = approved.map((r) => ({ id: r, name: room.names[r], present: snap.presence[r], host: r === 'host' }));
    if (role === 'host') {
      snap.inviteState = inviteState(room);
      snap.inviteExpiresAt = room.invite.expiresAt;
      const pending = pendingSlots(room);
      snap.pendingGuests = pending.map((g) => ({ id: g, requestedAt: room.members[g].requestedAt, displayName: room.names[g] }));
      if (pending.length) snap.pendingGuest = { requestedAt: room.members[pending[0]].requestedAt, displayName: room.names[pending[0]] };
    }
    snap.round = publicRound(room);
    snap.notice = room.notice ? { ...room.notice } : null;
    snap.platform = room.platform;
    snap.youtubeSearchEnabled = !!opts.youtubeApiKey;
    snap.selectedMatch = snap.round && snap.round.result.status === 'match' ? snap.round.result.matchId : null;
    snap.media = room.media;
    snap.playback = room.playback;
    snap.ready = {};
    for (const r of approved) snap.ready[r] = !!room.ready[r];
    snap.countdown = room.countdown ? { id: room.countdown.id, by: room.countdown.by, startsAt: room.countdown.startsAt, positionSec: room.countdown.positionSec } : null;
    snap.chat = room.chat.map((m) => ({ id: m.id, slot: m.slot, text: m.text, at: m.at }));
    snap.queue = room.queue.map((q) => ({ id: q.id, videoId: q.videoId, title: q.title, by: q.by }));
    snap.break = room.breakInfo ? { id: room.breakInfo.id, by: room.breakInfo.by, startsAt: room.breakInfo.startsAt, endsAt: room.breakInfo.endsAt, positionSec: room.breakInfo.positionSec } : null;
    snap.lags = {};
    for (const r of approved) { const l = room.lags[r]; if (l && now() - l.at < opts.lagTtlMs) snap.lags[r] = l.lagSec; }
    snap.reactions = room.reactions.map((r) => ({ id: r.id, slot: r.slot, emoji: r.emoji, at: r.at }));
    snap.voice = voiceView(room, role, approved);
    snap.viewing = { host: { ...room.viewing.host }, guest: { ...room.viewing.guest } };
    for (const r of approved) snap.viewing[r] = { ...room.viewing[r] };
    return snap;
  }

  /** Voz em malha: cada par (menor índice oferece) tem sua própria sessão e sinalização.
      O participante só recebe os sinais dos pares em que ele é uma das pontas. */
  function voiceView(room, role, approved) {
    const ready = { host: room.voice.ready.host, guest: room.voice.ready.guest };
    for (const r of approved) ready[r] = room.voice.ready[r];
    const links = [];
    if (room.voice.ready[role]) {
      for (const peer of approved) {
        if (peer === role || !room.voice.ready[peer]) continue;
        const p = pairOf(room, role, peer);
        const initiator = ROLES.indexOf(role) < ROLES.indexOf(peer);
        links.push({ peer, session: p.session, initiator, hasOffer: !!p.offer, hasAnswer: !!p.answer, remote: initiator ? p.answer : p.offer });
      }
    }
    const view = { ready, session: 1, hasOffer: false, hasAnswer: false, remote: null, links };
    const only = approved.filter((r) => r !== role);
    if (only.length === 1) {   // campos legados da dupla
      const p = pairOf(room, role, only[0]);
      const initiator = ROLES.indexOf(role) < ROLES.indexOf(only[0]);
      view.session = p.session; view.hasOffer = !!p.offer; view.hasAnswer = !!p.answer; view.remote = initiator ? p.answer : p.offer;
    } else if (links.length) view.session = Math.max(...links.map((l) => l.session));
    return view;
  }

  // ---------- long polling ----------
  function sendJson(res, status, body, extra) {
    if (res.writableEnded || res.destroyed) return;
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(extra || {}),
    });
    res.end(data);
  }

  function dropWaiter(code, role) {
    const slot = waiters.get(code);
    if (!slot || !slot[role]) return null;
    const w = slot[role];
    delete slot[role];
    if (!ROLES.some((r) => slot[r])) waiters.delete(code);
    clearTimeout(w.timer);
    waiterCount--;
    return w;
  }

  function notify(room) {
    for (const role of ROLES) {
      const w = dropWaiter(room.code, role);
      if (!w) continue;
      if (room.status === 'expired') sendJson(w.res, 410, { ok: false, error: 'room_expired' }, w.cors);
      else sendJson(w.res, 200, { ok: true, changed: true, snapshot: snapshotFor(room, role) }, w.cors);
    }
  }

  function parkWaiter(room, role, res, cors, waitSec) {
    const code = room.code;
    if (waiterCount >= opts.maxWaiters && !(waiters.get(code) && waiters.get(code)[role])) throw new HttpError(503, 'busy');
    const old = dropWaiter(code, role);
    if (old) sendJson(old.res, 409, { ok: false, error: 'session_replaced' }, old.cors); // um papel = uma sessão ativa
    const w = { res, cors };
    w.timer = setTimeout(() => {
      if (dropWaiter(code, role) === w) sendJson(res, 200, { ok: true, changed: false, revision: room.revision }, cors);
    }, waitSec * 1000);
    if (w.timer.unref) w.timer.unref();
    if (!waiters.has(code)) waiters.set(code, {});
    waiters.get(code)[role] = w;
    waiterCount++;
    res.on('close', () => { const slot = waiters.get(code); if (slot && slot[role] === w) dropWaiter(code, role); });
  }

  // ---------- autenticação ----------
  function authenticate(req, room) {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(h) : null;
    const token = m ? m[1] : null;
    // Compara com todas as credenciais sem curto-circuito; o papel é o de quem casar.
    let found = hashMatches(token, room ? room.hostHash : dummyHash) ? 'host' : null;
    for (const g of GUEST_SLOTS) {
      const ok = hashMatches(token, room && room.members[g] ? room.members[g].hash : dummyHash);
      if (ok && !found) found = g;
    }
    if (!room || !found) throw new HttpError(401, 'unauthorized');
    return found;
  }

  function authedRoom(req, code) {
    const room = rooms.get(code);
    if (room) tick(room);
    const role = authenticate(req, room || null);
    if (room.status === 'expired') throw new HttpError(410, 'room_expired');
    room.lastSeen[role] = now();
    return { room, role };
  }

  // ---------- ICE (STUN/TURN) para a voz ----------
  // Entregue só a participantes autenticados. Com `turn`, gera usuário/credencial temporários (padrão coturn
  // use-auth-secret): o segredo do TURN nunca sai do processo Node e as credenciais expiram sozinhas.
  function iceServersFor(role) {
    const list = opts.iceServers.map((s) => ({ ...s }));
    if (opts.turn) {
      const ttl = Math.max(60, Math.min(Number(opts.turn.ttlSec) || 6 * 3600, 24 * 3600));
      const username = `${Math.floor(now() / 1000) + ttl}:${role}`;
      const credential = crypto.createHmac('sha1', opts.turn.secret).update(username).digest('base64');
      list.push({ urls: opts.turn.urls, username, credential });
    }
    return list;
  }

  // ---------- leitura de corpo ----------
  function readJson(req, maxBytes = opts.maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return reject(new HttpError(415, 'unsupported_media_type'));
      const declared = req.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return reject(new HttpError(413, 'too_large'));
      const chunks = []; let size = 0, done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > maxBytes) { done = true; chunks.length = 0; reject(new HttpError(413, 'too_large')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        let v;
        try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reject(new HttpError(400, 'malformed')); }
        if (!isPlain(v)) return reject(new HttpError(400, 'malformed'));
        if (maxBytes > opts.maxBodyBytes && size > opts.maxBodyBytes && v.type !== 'voice.offer' && v.type !== 'voice.answer') {
          return reject(new HttpError(413, 'too_large'));
        }
        resolve(v);
      });
      req.on('error', () => { if (!done) { done = true; reject(new HttpError(400, 'malformed')); } });
    });
  }

  // ---------- ações ----------
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  // {session, sdp} (dupla, par inequívoco) ou {session, sdp, to} (sala com mais de duas pessoas).
  const voiceSignal = (p) => isPlain(p) && (exactKeys(p, ['session', 'sdp']) || (exactKeys(p, ['session', 'sdp', 'to']) && typeof p.to === 'string' && ROLES.includes(p.to))) &&
    intIn(p.session, 1, 2147483647) && typeof p.sdp === 'string' && p.sdp.startsWith('v=0\r\n') && p.sdp.length <= VOICE_SDP_LIMIT;
  function voicePeer(room, role, p) {
    const peers = approvedSlots(room).filter((r) => r !== role);
    if (has(p, 'to')) {
      if (p.to === role || !peers.includes(p.to)) throw new HttpError(409, 'voice_peer_unavailable');
      return p.to;
    }
    if (peers.length !== 1) throw new HttpError(400, 'voice_target_required');
    return peers[0];
  }
  const ACTIONS = {
    'platform.select': { roles: ['host'], check: (p) => isPlain(p) && exactKeys(p, ['platform']) && has(PLATFORMS, p.platform) },
    'round.start': { roles: ['host'], check: (p) => isPlain(p) && exactKeys(p, ['mode']) && (p.mode === 'surprise' || p.mode === 'recommend') },
    'round.manual': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['titleId']) && typeof p.titleId === 'string' },
    vote: { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['round', 'titleId', 'vote']) && intIn(p.round, 1, 1e6) && typeof p.titleId === 'string' && (p.vote === 'yes' || p.vote === 'no') },
    'media.youtube': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['titleId', 'videoId']) && typeof p.titleId === 'string' && YOUTUBE_ID_RE.test(p.videoId) },
    'video.open': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['videoId', 'title']) && YOUTUBE_ID_RE.test(p.videoId) && typeof p.title === 'string' && p.title.trim() === p.title && p.title.length >= 2 && p.title.length <= 160 && !/[\x00-\x1f\x7f<>]/.test(p.title) },
    playback: { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['titleId', 'videoId', 'action', 'positionSec']) && typeof p.titleId === 'string' && YOUTUBE_ID_RE.test(p.videoId) && ['play', 'pause', 'seek'].includes(p.action) && typeof p.positionSec === 'number' && Number.isFinite(p.positionSec) && p.positionSec >= 0 && p.positionSec <= 86400 },
    'media.netflix': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['titleId', 'watchId']) && typeof p.titleId === 'string' && typeof p.watchId === 'string' && NETFLIX_WATCH_ID_RE.test(p.watchId) },
    'playback.netflix': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['titleId', 'watchId', 'action', 'positionSec']) && typeof p.titleId === 'string' && typeof p.watchId === 'string' && NETFLIX_WATCH_ID_RE.test(p.watchId) && ['play', 'pause', 'seek'].includes(p.action) && typeof p.positionSec === 'number' && Number.isFinite(p.positionSec) && p.positionSec >= 0 && p.positionSec <= 86400 },
    viewing: { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['titleId', 'progress', 'rating', 'listed']) && typeof p.titleId === 'string' && intIn(p.progress, 0, 100) && (p.rating === -1 || p.rating === 0 || p.rating === 1) && typeof p.listed === 'boolean' },
    'ready.set': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['ready']) && typeof p.ready === 'boolean' },
    // Cada player diz o quanto está adiantado (+) ou atrasado (-) em relação à posição da sala; só um número, e vale por poucos segundos.
    'chat.send': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['text']) && typeof p.text === 'string' && p.text.length >= 1 && p.text.length <= 300 && p.text.trim() === p.text && !/[\x00-\x1f\x7f]/.test(p.text) },
    'queue.add': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['videoId', 'title']) && YOUTUBE_ID_RE.test(p.videoId) && typeof p.title === 'string' && p.title.trim() === p.title && p.title.length >= 2 && p.title.length <= 160 && !/[\x00-\x1f\x7f<>]/.test(p.title) },
    'queue.remove': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['id']) && intIn(p.id, 1, 1e9) },
    // o videoId é o primeiro da fila que quem pediu estava vendo: se vários players avisarem que o vídeo acabou, só o primeiro pedido vale
    'queue.next': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['videoId']) && YOUTUBE_ID_RE.test(p.videoId) },
    'break.start': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['minutes']) && intIn(p.minutes, 1, 30) },
    'break.end': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, []) },
    'lag.report': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['lagSec']) && intIn(p.lagSec, -3600, 3600) },
    'sync.start': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, []) },
    'sync.cancel': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, []) },
    'reaction.send': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['emoji']) && typeof p.emoji === 'string' && REACTIONS.includes(p.emoji) },
    'voice.ready': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, ['ready']) && typeof p.ready === 'boolean' },
    'voice.retry': { roles: ROLES, check: (p) => isPlain(p) && exactKeys(p, []) },
    'voice.offer': { roles: ROLES, check: (p) => voiceSignal(p) },
    'voice.answer': { roles: ROLES, check: (p) => voiceSignal(p) },
  };

  function applyAction(room, role, type, p) {
    if (has(p, 'titleId') && !titleIds.has(p.titleId) && !(type === 'playback' && p.titleId === `youtube:${p.videoId}`)) throw new HttpError(400, 'unknown_title');
    const eng = TO_ENGINE[role];
    // Durante a contagem, pausas e posições vindas dos players (efeito de pausar/ajustar para todos) são ignoradas;
    // dar play à mão cancela a contagem; trocar de vídeo ou de plataforma também.
    if (room.countdown && (type === 'playback' || type === 'playback.netflix')) { if (p.action === 'play') cancelCountdown(room); else return; }
    if (room.breakInfo && (type === 'playback' || type === 'playback.netflix')) { if (p.action === 'play') cancelBreak(room); else return; }
    if (room.breakInfo && ['platform.select', 'round.start', 'round.manual', 'media.youtube', 'media.netflix', 'video.open', 'queue.next'].includes(type)) cancelBreak(room);
    if (room.countdown && ['platform.select', 'round.start', 'round.manual', 'media.youtube', 'media.netflix', 'video.open', 'queue.next'].includes(type)) cancelCountdown(room);
    switch (type) {
      case 'platform.select':
        if (room.platform !== p.platform) {
          room.platform = p.platform;
          room.round = null;
          room.notice = null;
          room.media = null;
          room.playback = null;
          room.queue = [];
        }
        break;
      case 'round.start':
        {
          const available = catalogSource === 'tmdb' && room.platform ? catalog.filter((item) => item.watchProviders?.includes(PLATFORMS[room.platform])) : catalog;
          if (!available.length) throw new HttpError(409, 'no_titles_on_platform');
          room.round = MatchEngine.createRound(room.round, available, legacySaved(room), { mode: p.mode, people: approvedSlots(room).map((r) => TO_ENGINE[r]) });
        }
        room.notice = null;
        room.media = null;
        room.playback = null;
        break;
      case 'round.manual':
        if (MatchEngine.resolveRound(room.round).status === 'match') throw new HttpError(409, 'round_locked');
        if (catalogSource === 'tmdb' && room.platform && !catalog.find((item) => item.id === p.titleId)?.watchProviders?.includes(PLATFORMS[room.platform])) throw new HttpError(409, 'title_not_on_platform');
        room.round = MatchEngine.manualRound(room.round, catalog, p.titleId, eng, approvedSlots(room).map((r) => TO_ENGINE[r]));
        room.notice = null;
        room.media = null;
        room.playback = null;
        break;
      case 'vote':
        if (!room.round) throw new HttpError(409, 'no_round');
        if (p.round !== room.round.roundNumber) throw new HttpError(409, 'stale_round');
        if (!room.round.picks.includes(p.titleId)) throw new HttpError(400, 'unknown_title');
        if (MatchEngine.resolveRound(room.round).status === 'match') throw new HttpError(409, 'round_locked');
        if (!MatchEngine.peopleOf(room.round).includes(eng)) throw new HttpError(409, 'not_in_round');
        room.round = MatchEngine.castVote(room.round, eng, p.titleId, p.vote);
        break;
      case 'media.youtube': {
        const result = MatchEngine.resolveRound(room.round);
        if (result.status !== 'match' || result.matchId !== p.titleId) throw new HttpError(409, 'no_match');
        if (room.platform !== 'youtube') throw new HttpError(409, 'wrong_platform');
        room.media = { provider: 'youtube', titleId: p.titleId, videoId: p.videoId };
        room.playback = { titleId: p.titleId, videoId: p.videoId, state: 'playing', positionSec: 0, updatedBy: role, updatedAt: now(), version: (room.playback?.version || 0) + 1 };
        break;
      }
      case 'media.netflix': {
        const result = MatchEngine.resolveRound(room.round);
        if (result.status !== 'match' || result.matchId !== p.titleId) throw new HttpError(409, 'no_match');
        if (room.platform !== 'netflix') throw new HttpError(409, 'wrong_platform');
        room.media = { provider: 'netflix', titleId: p.titleId, watchId: p.watchId };
        room.playback = { titleId: p.titleId, watchId: p.watchId, state: 'playing', positionSec: 0, updatedBy: role, updatedAt: now(), version: (room.playback?.version || 0) + 1 };
        break;
      }
      case 'playback.netflix': {
        const res = MatchEngine.resolveRound(room.round);
        if (res.status !== 'match' || res.matchId !== p.titleId) throw new HttpError(409, 'no_match');
        if (room.platform !== 'netflix') throw new HttpError(409, 'wrong_platform');
        if (room.media?.provider !== 'netflix' || room.media.titleId !== p.titleId || room.media.watchId !== p.watchId) throw new HttpError(409, 'media_not_selected');
        const state = p.action === 'play' ? 'playing' : p.action === 'pause' ? 'paused' : (room.playback ? room.playback.state : 'paused');
        room.playback = { titleId: p.titleId, watchId: p.watchId, state, positionSec: p.positionSec, updatedBy: role, updatedAt: now(), version: (room.playback?.version || 0) + 1 };
        break;
      }
      case 'video.open':
        if (room.platform !== 'youtube') throw new HttpError(409, 'wrong_platform');
        room.round = null;
        room.queue = room.queue.filter((q) => q.videoId !== p.videoId);   // abrir agora um vídeo que estava na fila tira ele de lá
        room.media = { provider: 'youtube', titleId: `youtube:${p.videoId}`, videoId: p.videoId, title: p.title };
        room.playback = { titleId: room.media.titleId, videoId: p.videoId, state: 'playing', positionSec: 0, updatedBy: role, updatedAt: now(), version: (room.playback?.version || 0) + 1 };
        break;
      case 'chat.send': {
        const t = now();
        if (t - room.lastChatAt[role] < opts.chatGapMs) throw new HttpError(429, 'rate_limited');
        room.lastChatAt[role] = t;
        room.chatSeq += 1;
        room.chat.push({ id: room.chatSeq, slot: role, text: p.text, at: t });
        if (room.chat.length > opts.chatMax) room.chat.shift();
        break;
      }
      case 'queue.add': {
        if (room.platform !== 'youtube') throw new HttpError(409, 'wrong_platform');
        if (room.queue.length >= opts.queueMax) throw new HttpError(409, 'queue_full');
        if (room.queue.some((q) => q.videoId === p.videoId)) throw new HttpError(409, 'already_queued');
        room.queueSeq += 1;
        room.queue.push({ id: room.queueSeq, videoId: p.videoId, title: p.title, by: role });
        break;
      }
      case 'queue.remove': {
        const i = room.queue.findIndex((q) => q.id === p.id);
        if (i < 0) throw new HttpError(409, 'not_in_queue');
        room.queue.splice(i, 1);
        break;
      }
      case 'queue.next': {
        if (room.platform !== 'youtube') throw new HttpError(409, 'wrong_platform');
        const head = room.queue[0];
        if (!head) throw new HttpError(409, 'queue_empty');
        if (head.videoId !== p.videoId) throw new HttpError(409, 'queue_changed');
        room.queue.shift();
        room.round = null;
        room.media = { provider: 'youtube', titleId: `youtube:${head.videoId}`, videoId: head.videoId, title: head.title };
        room.playback = { titleId: room.media.titleId, videoId: head.videoId, state: 'playing', positionSec: 0, updatedBy: role, updatedAt: now(), version: (room.playback?.version || 0) + 1 };
        break;
      }
      case 'playback': {
        const res = MatchEngine.resolveRound(room.round);
        const directVideo = room.platform === 'youtube' && p.titleId === `youtube:${p.videoId}` && room.media?.titleId === p.titleId && room.media?.videoId === p.videoId;
        if (!directVideo && (res.status !== 'match' || res.matchId !== p.titleId)) throw new HttpError(409, 'no_match');
        if (!room.media || room.media.provider !== 'youtube' || room.media.titleId !== p.titleId || room.media.videoId !== p.videoId) throw new HttpError(409, 'media_not_selected');
        const state = p.action === 'play' ? 'playing' : p.action === 'pause' ? 'paused' : (room.playback ? room.playback.state : 'paused');
        room.playback = { titleId: p.titleId, videoId: p.videoId, state, positionSec: p.positionSec, updatedBy: role, updatedAt: now(), version: (room.playback?.version || 0) + 1 };
        break;
      }
      case 'viewing':
        room.viewing[role][p.titleId] = { progress: p.progress, rating: p.rating, listed: p.listed };
        break;
      case 'ready.set':
        room.ready[role] = p.ready;
        break;
      case 'break.start': {
        if (!room.media || !room.playback) throw new HttpError(409, 'no_media');
        if (room.countdown) throw new HttpError(409, 'countdown_active');
        const t = now();
        if (room.breakInfo) {                                     // já em intervalo: estende (no máximo 30 min a partir de agora)
          room.breakInfo.endsAt = Math.min(t + opts.breakMaxMs, room.breakInfo.endsAt + p.minutes * 60000);
          scheduleBreak(room);
          break;
        }
        const pb = room.playback;
        const estimate = pb.state === 'playing' ? pb.positionSec + Math.max(0, (t - pb.updatedAt) / 1000) : pb.positionSec;
        const position = Math.min(86400, Math.max(0, estimate));
        room.syncSeq += 1;
        room.breakInfo = { id: room.syncSeq, by: role, startsAt: t, endsAt: Math.min(t + opts.breakMaxMs, t + p.minutes * 60000), positionSec: position };
        room.playback = { ...pb, state: 'paused', positionSec: position, updatedBy: role, updatedAt: t, version: pb.version + 1, syncId: room.syncSeq };
        for (const r of ROLES) room.ready[r] = false;
        scheduleBreak(room);
        break;
      }
      case 'break.end':
        if (!room.breakInfo) throw new HttpError(409, 'no_break');
        endBreak(room, role);
        break;
      case 'lag.report':
        room.lags[role] = p.lagSec === 0 && !room.lags[role] ? null : { lagSec: p.lagSec, at: now() };
        break;
      case 'sync.start': {
        if (!room.media || !room.playback) throw new HttpError(409, 'no_media');
        if (room.countdown) throw new HttpError(409, 'countdown_active');
        const pb = room.playback, t = now();
        cancelBreak(room);                                          // sincronizar durante um intervalo encerra o intervalo e já conta 3-2-1
        const estimate = pb.state === 'playing' ? pb.positionSec + Math.max(0, (t - pb.updatedAt) / 1000) : pb.positionSec;
        const position = Math.min(86400, Math.max(0, estimate));
        room.syncSeq += 1;
        room.countdown = { id: room.syncSeq, by: role, startsAt: t + opts.countdownMs, positionSec: position };
        room.playback = { ...pb, state: 'paused', positionSec: position, updatedBy: role, updatedAt: t, version: pb.version + 1, syncId: room.syncSeq };
        for (const r of ROLES) room.ready[r] = false;   // todos saem do "pronto": a contagem é o sinal de largada
        scheduleCountdown(room);
        break;
      }
      case 'sync.cancel':
        if (!room.countdown) throw new HttpError(409, 'no_countdown');
        if (role !== 'host' && role !== room.countdown.by) throw new HttpError(403, 'wrong_role');
        cancelCountdown(room);
        break;
      case 'reaction.send': {
        const t = now();
        if (t - room.lastReactionAt[role] < opts.reactionGapMs) throw new HttpError(429, 'rate_limited');
        room.lastReactionAt[role] = t;
        room.reactionSeq += 1;
        room.reactions.push({ id: room.reactionSeq, slot: role, emoji: p.emoji, at: t });
        if (room.reactions.length > 8) room.reactions.shift();
        break;
      }
      case 'voice.ready':
        if (room.voice.ready[role] !== p.ready) {
          room.voice.ready[role] = p.ready;
          bumpPairsOf(room, role);
        }
        break;
      case 'voice.retry':
        if (!room.voice.ready[role]) throw new HttpError(409, 'voice_not_ready');
        bumpPairsOf(room, role);
        break;
      case 'voice.offer': {
        const peer = voicePeer(room, role, p);
        if (!room.voice.ready[role] || !room.voice.ready[peer]) throw new HttpError(409, 'voice_not_ready');
        if (ROLES.indexOf(role) > ROLES.indexOf(peer)) throw new HttpError(403, 'wrong_role'); // o menor índice oferece
        const pair = pairOf(room, role, peer);
        if (p.session !== pair.session || pair.offer) throw new HttpError(409, 'stale_voice_session');
        pair.offer = { session: p.session, sdp: p.sdp };
        break;
      }
      case 'voice.answer': {
        const peer = voicePeer(room, role, p);
        if (!room.voice.ready[role] || !room.voice.ready[peer]) throw new HttpError(409, 'voice_not_ready');
        if (ROLES.indexOf(role) < ROLES.indexOf(peer)) throw new HttpError(403, 'wrong_role');
        const pair = pairOf(room, role, peer);
        if (!pair.offer) throw new HttpError(409, 'voice_not_ready');
        if (p.session !== pair.session || pair.answer) throw new HttpError(409, 'stale_voice_session');
        pair.answer = { session: p.session, sdp: p.sdp };
        break;
      }
    }
  }

  async function postAction(req, code) {
    const { room, role } = authedRoom(req, code);
    const body = await readJson(req, 32768); // SDP com candidatos ICE completos; outros payloads seguem validação estrita.
    if (room.status !== 'open') throw new HttpError(409, 'room_closed');
    if (roomStatus(room) !== 'active' || !isApproved(room, role)) throw new HttpError(409, 'not_active'); // exige participantes aprovados
    if (FORBIDDEN_KEYS.some((k) => has(body, k))) throw new HttpError(400, 'declared_identity');
    if (!exactKeys(body, ['v', 'clientSeq', 'type', 'payload'])) throw new HttpError(400, 'malformed');
    if (body.v !== PROTOCOL_VERSION) throw new HttpError(400, 'bad_version');
    if (typeof body.type !== 'string' || !has(ACTIONS, body.type)) throw new HttpError(400, 'unknown_type');
    if (!ACTIONS[body.type].roles.includes(role)) throw new HttpError(403, 'wrong_role');
    if (!intIn(body.clientSeq, 1, 2147483647)) throw new HttpError(400, 'bad_seq');
    if (body.clientSeq === room.lastSeq[role]) { // reenvio idempotente: confirma sem reaplicar
      const digest = sha256(JSON.stringify({ type: body.type, payload: body.payload }));
      const previous = room.lastActionHash[role];
      if (!previous || !crypto.timingSafeEqual(digest, previous)) throw new HttpError(409, 'seq_conflict');
      return { ok: true, duplicate: true, revision: room.revision, snapshot: snapshotFor(room, role) };
    }
    if (body.clientSeq < room.lastSeq[role]) throw new HttpError(409, 'stale_seq');
    if (!ACTIONS[body.type].check(body.payload)) throw new HttpError(400, 'bad_payload');
    applyAction(room, role, body.type, body.payload);
    room.lastSeq[role] = body.clientSeq; // só avança depois de validar e aplicar
    room.lastActionHash[role] = sha256(JSON.stringify({ type: body.type, payload: body.payload }));
    bump(room);
    return { ok: true, duplicate: false, revision: room.revision, snapshot: snapshotFor(room, role) };
  }

  // ---------- rotas ----------
  async function createRoom(ip, displayName = 'Host', capacity = DEFAULT_CAPACITY) {
    rateLimit(ip, 'create');
    if (rooms.size >= opts.maxRooms) throw new HttpError(503, 'busy');
    const code = allocateCode();
    const hostToken = newSecret();
    const t = now();
    const slotMap = (v) => Object.fromEntries(ROLES.map((r) => [r, typeof v === 'function' ? v(r) : v]));
    const room = {
      code, status: 'open', revision: 1, createdAt: t, expiresAt: t + opts.roomTtlMs, endedAt: null, capacity,
      hostHash: sha256(hostToken), members: {}, invite: null, notice: null,
      names: { host: displayName, guest: 'Convidado', guest2: 'Convidado', guest3: 'Convidado' },
      lastSeq: slotMap(0), lastActionHash: slotMap(null), lastSeen: slotMap((r) => (r === 'host' ? t : 0)),
      round: null, platform: null, media: null, playback: null, viewing: slotMap(() => ({})),
      voice: { ready: slotMap(false), pairs: {} },
      lags: slotMap(null), breakInfo: null, breakTimer: null, queue: [], queueSeq: 0, chat: [], chatSeq: 0, lastChatAt: slotMap(0), ready: slotMap(false), countdown: null, countdownTimer: null, syncSeq: 0, reactions: [], reactionSeq: 0, lastReactionAt: slotMap(0),
    };
    const inviteSecret = newInvite(room);
    rooms.set(code, room);
    return { ok: true, role: 'host', code, hostToken, inviteSecret, inviteExpiresAt: room.invite.expiresAt, roomExpiresAt: room.expiresAt, capacity };
  }

  async function join(req, ip, code) {
    rateLimit(ip, 'join');
    const body = await readJson(req);
    const named = exactKeys(body, ['inviteSecret', 'displayName']);
    if (!named && !exactKeys(body, ['inviteSecret'])) throw new HttpError(400, 'malformed');
    if (named && !validDisplayName(body.displayName)) throw new HttpError(400, 'bad_display_name');
    const room = rooms.get(code);
    if (room) tick(room);
    const secret = body.inviteSecret;
    const usable = !!room && room.status === 'open';
    const match = hashMatches(secret, usable ? room.invite.hash : dummyHash);
    if (!usable || !match) {
      throw new HttpError(403, 'invalid_invite');
    }
    if (room.invite.consumed) throw new HttpError(409, 'invite_used');
    if (now() >= room.invite.expiresAt) throw new HttpError(409, 'invite_expired');
    if (liveCount(room) >= room.capacity) throw new HttpError(409, 'room_full');
    const slot = GUEST_SLOTS.slice(0, room.capacity - 1).find((g) => !LIVE.includes(room.members[g]?.state));
    if (!slot) throw new HttpError(409, 'room_full');
    const guestToken = newSecret();
    room.invite.consumed = true;               // uso único: queimado ao pedir entrada
    room.members[slot] = { hash: sha256(guestToken), state: 'pending', requestedAt: now() };  // substitui credencial de quem saiu/foi removido
    room.names[slot] = named ? body.displayName : 'Convidado';
    room.lastSeq[slot] = 0; room.lastActionHash[slot] = null; room.viewing[slot] = {};
    room.lastSeen[slot] = now();
    bump(room);
    return { ok: true, role: slot, code, guestToken, status: 'pending_approval' };
  }

  async function admission(req, code) {
    const { room, role } = authedRoom(req, code);
    if (role !== 'host') throw new HttpError(403, 'wrong_role');
    const body = await readJson(req);
    if (!exactKeys(body, ['decision']) && !exactKeys(body, ['decision', 'participant'])) throw new HttpError(400, 'malformed');
    if (room.status !== 'open') throw new HttpError(409, 'room_closed');
    const d = body.decision;
    if (d !== 'approve' && d !== 'deny' && d !== 'remove') throw new HttpError(400, 'bad_decision');
    const needed = d === 'remove' ? 'approved' : 'pending';
    const candidates = GUEST_SLOTS.filter((g) => room.members[g]?.state === needed);
    let slot;
    if (has(body, 'participant')) {
      if (!GUEST_SLOTS.includes(body.participant)) throw new HttpError(400, 'bad_participant');
      slot = body.participant;
    } else if (candidates.length === 1) slot = candidates[0];
    else if (candidates.length === 0) throw new HttpError(409, d === 'remove' ? 'no_guest' : 'no_pending_guest');
    else throw new HttpError(400, 'participant_required');
    const g = room.members[slot];
    if (!g || g.state !== needed) throw new HttpError(409, d === 'remove' ? 'no_guest' : 'no_pending_guest');
    if (d === 'approve') {
      if (approvedSlots(room).length >= room.capacity) throw new HttpError(409, 'room_full');
      g.state = 'approved';
      compositionChanged(room, 'joined', slot);
    } else if (d === 'deny') g.state = 'denied';
    else {
      g.state = 'removed';
      room.voice.ready[slot] = false; room.ready[slot] = false;
      bumpPairsOf(room, slot);
      compositionChanged(room, 'removed', slot);
    }
    if (d === 'deny') { room.voice.ready[slot] = false; room.ready[slot] = false; bumpPairsOf(room, slot); }
    bump(room);
    return { ok: true, snapshot: snapshotFor(room, 'host') };
  }

  async function leave(req, code) {
    const { room, role } = authedRoom(req, code);
    if (role === 'host') throw new HttpError(403, 'wrong_role');   // o Host encerra a sala em /close
    const body = await readJson(req);
    if (!exactKeys(body, [])) throw new HttpError(400, 'malformed');
    const g = room.members[role];
    if (room.status === 'open' && g && LIVE.includes(g.state)) {
      const wasApproved = g.state === 'approved';
      g.state = 'left';
      room.voice.ready[role] = false; room.ready[role] = false;
      bumpPairsOf(room, role);
      if (wasApproved) compositionChanged(room, 'left', role);
      bump(room);
    }
    return { ok: true };
  }

  async function updateProfile(req, code) {
    const { room, role } = authedRoom(req, code);
    const body = await readJson(req);
    if (!exactKeys(body, ['displayName']) || !validDisplayName(body.displayName)) throw new HttpError(400, 'bad_display_name');
    if (room.status !== 'open') throw new HttpError(409, 'room_closed');
    if (role !== 'host' && !LIVE.includes(room.members[role]?.state)) throw new HttpError(403, 'not_admitted');
    room.names[role] = body.displayName;
    bump(room);
    return { ok: true, snapshot: snapshotFor(room, role) };
  }

  async function reinvite(req, code) {
    const { room, role } = authedRoom(req, code);
    if (role !== 'host') throw new HttpError(403, 'wrong_role');
    const body = await readJson(req);
    if (!exactKeys(body, [])) throw new HttpError(400, 'malformed');
    if (room.status !== 'open') throw new HttpError(409, 'room_closed');
    if (liveCount(room) >= room.capacity) throw new HttpError(409, room.capacity === 2 ? 'guest_present' : 'room_full');
    const inviteSecret = newInvite(room);   // substitui o convite anterior não usado
    bump(room);
    return { ok: true, inviteSecret, inviteExpiresAt: room.invite.expiresAt };
  }

  async function closeRoom(req, code) {
    const { room, role } = authedRoom(req, code);
    if (role !== 'host') throw new HttpError(403, 'wrong_role');
    const body = await readJson(req);
    if (!exactKeys(body, [])) throw new HttpError(400, 'malformed');
    if (room.status === 'open') {
      room.status = 'closed'; room.endedAt = now();
      cancelCountdown(room);
      cancelBreak(room);
      room.voice.pairs = {};
      bump(room);
    }
    return { ok: true };
  }

  function getState(req, res, code, url, cors) {
    for (const k of url.searchParams.keys()) {
      if (k !== 'after' && k !== 'wait') throw new HttpError(400, /token|secret|credential|auth|key/i.test(k) ? 'credentials_in_url_forbidden' : 'bad_query');
    }
    const num = (name, max) => {
      const v = url.searchParams.get(name);
      if (v === null) return 0;
      if (!/^\d{1,10}$/.test(v) || Number(v) > max) throw new HttpError(400, 'bad_query');
      return Number(v);
    };
    const after = num('after', 2147483647), wait = num('wait', opts.maxWaitSec);
    const { room, role } = authedRoom(req, code);
    if (room.revision > after) return sendJson(res, 200, { ok: true, changed: true, snapshot: snapshotFor(room, role) }, cors);
    if (wait === 0 || room.status !== 'open') return sendJson(res, 200, { ok: true, changed: false, revision: room.revision }, cors);
    parkWaiter(room, role, res, cors, wait);
  }

  async function searchYouTube(req, code, url, ip) {
    const { room } = authedRoom(req, code);
    if (roomStatus(room) !== 'active') throw new HttpError(409, 'room_not_active');
    if (room.platform !== 'youtube') throw new HttpError(409, 'wrong_platform');
    if (!opts.youtubeApiKey) throw new HttpError(503, 'youtube_search_not_configured');
    if ([...url.searchParams.keys()].some((k) => k !== 'q') || url.searchParams.getAll('q').length !== 1) throw new HttpError(400, 'bad_query');
    const q = url.searchParams.get('q')?.trim();
    if (!q || q.length < 2 || q.length > 80 || /[\x00-\x1f\x7f]/.test(q)) throw new HttpError(400, 'bad_query');
    rateLimit(ip, 'youtubeSearch');
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/search');
    for (const [k, v] of Object.entries({ part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '8', regionCode: 'BR', safeSearch: 'moderate', q, key: opts.youtubeApiKey })) endpoint.searchParams.set(k, v);
    let response;
    try { response = await fetchImpl(endpoint.toString(), { signal: AbortSignal.timeout(8000), cache: 'no-store' }); }
    catch { throw new HttpError(502, 'youtube_unavailable'); }
    if (!response.ok) throw new HttpError(502, 'youtube_unavailable');
    let data;
    try { data = await response.json(); } catch { throw new HttpError(502, 'youtube_unavailable'); }
    const results = Array.isArray(data?.items) ? data.items.flatMap((item) => {
      const videoId = item?.id?.videoId;
      if (!YOUTUBE_ID_RE.test(videoId)) return [];
      const title = String(item?.snippet?.title || '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 160) || 'Vídeo do YouTube';
      return [{ videoId, title, channel: String(item?.snippet?.channelTitle || '').slice(0, 80), thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` }];
    }) : [];
    return { ok: true, results };
  }

  /** Título de um vídeo a partir do id (oEmbed do YouTube, sem chave). Falha silenciosa: quem chama usa um título genérico. */
  async function youtubeTitle(req, code, url, ip) {
    const { room } = authedRoom(req, code);
    if (roomStatus(room) !== 'active') throw new HttpError(409, 'room_not_active');
    if ([...url.searchParams.keys()].some((k) => k !== 'id') || url.searchParams.getAll('id').length !== 1) throw new HttpError(400, 'bad_query');
    const id = url.searchParams.get('id');
    if (!YOUTUBE_ID_RE.test(id)) throw new HttpError(400, 'bad_query');
    rateLimit(ip, 'youtubeSearch');
    const endpoint = new URL('https://www.youtube.com/oembed');
    endpoint.searchParams.set('url', 'https://www.youtube.com/watch?v=' + id); endpoint.searchParams.set('format', 'json');
    let title = '';
    try {
      const response = await fetchImpl(endpoint.toString(), { signal: AbortSignal.timeout(4000), cache: 'no-store' });
      if (response.ok) title = String((await response.json())?.title || '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 160);
    } catch { /* sem título: o app usa o genérico */ }
    return { ok: true, title: title.length >= 2 ? title : null };
  }

  // ---------- Origin / CORS ----------
  function corsFor(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return {};                       // cliente que não é navegador
    const a = server.address();
    const loopback = opts.servePrototype && a && ['127.0.0.1', '::1', 'localhost'].includes(a.address);
    const localOrigins = loopback ? new Set([`http://127.0.0.1:${a.port}`, `http://localhost:${a.port}`, `http://[::1]:${a.port}`]) : null;
    if (typeof origin !== 'string' || (!allowedOrigins.has(origin) && !localOrigins?.has(origin))) throw new HttpError(403, 'origin_not_allowed');
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }

  const staticFiles = new Map([
    ['/', 'index.html'], ['/index.html', 'index.html'],
    ['/src/catalog.js', 'src/catalog.js'], ['/src/match-engine.js', 'src/match-engine.js'], ['/src/tonight.js', 'src/tonight.js'],
    ['/server/client.js', 'server/client.js'], ['/server/online-ui.js', 'server/online-ui.js'], ['/server/youtube-player.js', 'server/youtube-player.js'], ['/server/voice.js', 'server/voice.js'], ['/server/p2p-link.js', 'server/p2p-link.js'], ['/server/p2p-rendezvous.js', 'server/p2p-rendezvous.js'], ['/server/nerd-stats.js', 'server/nerd-stats.js'], ['/server/first-run.js', 'server/first-run.js'], ['/server/tribute.js', 'server/tribute.js'], ['/server/icons.js', 'server/icons.js'], ['/server/ambient.js', 'server/ambient.js'], ['/server/reconnect.js', 'server/reconnect.js'], ['/server/audio-check.js', 'server/audio-check.js'], ['/server/updates-ui.js', 'server/updates-ui.js'], ['/server/ducking.js', 'server/ducking.js'], ['/server/telemetry.js', 'server/telemetry.js'], ['/server/feedback.js', 'server/feedback.js'], ['/server/lag-watch.js', 'server/lag-watch.js'], ['/server/chat.js', 'server/chat.js'], ['/stats-config.json', 'stats-config.json'], ['/server/netflix-bridge.js', 'server/netflix-bridge.js'], ['/extension-bridge/src/bridge-protocol.js', 'extension-bridge/src/bridge-protocol.js'],
  ]);
  async function serveFile(p, res) {
    let rel = staticFiles.get(p);
    if (!rel && /^\/assets\/[a-z0-9-]+\.(png|svg)$/.test(p)) rel = p.slice(1);
    if (!rel) throw new HttpError(404, 'not_found');
    const data = p === '/src/catalog.js' && catalogSource === 'tmdb'
      ? Buffer.from('window.DuoCatalog=' + JSON.stringify(catalog).replace(/</g, '\\u003c') + ';window.DuoCatalogSource="tmdb";', 'utf8')
      : await fs.readFile(path.join(__dirname, '..', rel)).catch((e) => {
      if (e.code === 'ENOENT') throw new HttpError(404, 'not_found');
      throw e;
    });
    const mime = rel.endsWith('.html') ? 'text/html' : rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    const inlineHash = rel === 'index.html' ? inlineScriptSource(data.toString('utf8')) : '';
    res.writeHead(200, { 'Content-Type': mime + (mime.startsWith('text/') ? '; charset=utf-8' : ''), 'Content-Length': data.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': rel === 'index.html' ? 'strict-origin-when-cross-origin' : 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com${inlineHash}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://image.tmdb.org https://www.themoviedb.org https://i.ytimg.com; connect-src 'self' ${opts.relayOrigins.join(' ')}${opts.statsOrigin ? ' ' + opts.statsOrigin : ''}; frame-src https://www.youtube.com https://www.youtube-nocookie.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
    res.end(data);
  }

  async function handle(req, res) {
    let route = 'unknown', cors = {};
    try {
      const ip = req.socket.remoteAddress || 'unknown';
      cors = corsFor(req);
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      let m;
      if (req.method === 'OPTIONS') {
        route = 'OPTIONS';
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' });
        return res.end();
      }
      rateLimit(ip, 'general');
      if (opts.servePrototype && req.method === 'GET' && (staticFiles.has(p) || p.startsWith('/assets/'))) {
        route = '/prototype';
        if (url.search) throw new HttpError(400, 'bad_query');
        return await serveFile(p, res);
      }
      if (req.method === 'GET' && p === '/healthz') { route = '/healthz'; return sendJson(res, 200, { ok: true }, cors); }
      if (req.method === 'POST' && p === '/v1/rooms') {
        route = '/v1/rooms';
        if (url.search) throw new HttpError(400, 'bad_query');
        const body = await readJson(req);
        const known = Object.keys(body).every((k) => k === 'displayName' || k === 'maxParticipants');
        if (!known) throw new HttpError(400, 'malformed');
        if (has(body, 'displayName') && !validDisplayName(body.displayName)) throw new HttpError(400, 'bad_display_name');
        if (has(body, 'maxParticipants') && !intIn(body.maxParticipants, 2, MAX_PARTICIPANTS)) throw new HttpError(400, 'bad_capacity');
        return sendJson(res, 201, await createRoom(ip, body.displayName, body.maxParticipants), cors);
      }
      if ((m = /^\/v1\/rooms\/(\d{6})\/ice$/.exec(p))) {
        route = '/v1/rooms/:code/ice';
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
        if (url.search) throw new HttpError(400, 'bad_query');
        const { room, role } = authedRoom(req, m[1]);
        if (role !== 'host' && room.members[role]?.state !== 'approved') throw new HttpError(403, 'not_approved');   // pendente não recebe TURN
        return sendJson(res, 200, { ok: true, iceServers: iceServersFor(role) }, cors);
      }
      if ((m = /^\/v1\/rooms\/(\d{6})\/youtube\/search$/.exec(p))) {
        route = '/v1/rooms/:code/youtube/search';
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
        return sendJson(res, 200, await searchYouTube(req, m[1], url, ip), cors);
      }
      if ((m = /^\/v1\/rooms\/(\d{6})\/youtube\/title$/.exec(p))) {
        route = '/v1/rooms/:code/youtube/title';
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
        return sendJson(res, 200, await youtubeTitle(req, m[1], url, ip), cors);
      }
      if ((m = /^\/v1\/rooms\/(\d{6})\/(state|actions|join|admission|invite|close|profile|leave)$/.exec(p))) {
        const code = m[1], what = m[2];
        route = '/v1/rooms/:code/' + what;
        if (what === 'state') {
          if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
          return getState(req, res, code, url, cors);
        }
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
        if (url.search) throw new HttpError(400, 'bad_query');
        const fn = { actions: () => postAction(req, code), join: () => join(req, ip, code), admission: () => admission(req, code), invite: () => reinvite(req, code), close: () => closeRoom(req, code), profile: () => updateProfile(req, code), leave: () => leave(req, code) }[what];
        return sendJson(res, 200, await fn(), cors);
      }
      throw new HttpError(404, 'not_found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const extra = status === 413 ? { Connection: 'close' } : {};
      sendJson(res, status, { ok: false, error: e instanceof HttpError ? e.code : 'internal' }, { ...cors, ...extra });
      log(req.method, route, status);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => sendJson(res, 500, { ok: false, error: 'internal' }));
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;   // vale para receber a requisição; a espera do long poll é da resposta
  server.maxHeadersCount = 40;
  server.keepAliveTimeout = 5000;

  function sweep() {
    const t = now();
    for (const room of [...rooms.values()]) {
      tick(room);
      if (room.status !== 'open' && room.endedAt !== null && t - room.endedAt > opts.closedGraceMs) {
        for (const r of ROLES) dropWaiter(room.code, r);
        rooms.delete(room.code);
      }
    }
    for (const [k, b] of buckets) if (t >= b.resetAt) buckets.delete(k);
  }
  let sweeper = null;

  function listen(port = opts.port, host = opts.host) {
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (!loopback && !opts.allowNonLoopback) {
      return Promise.reject(new Error('Recusando escutar em interface não-loopback sem allowNonLoopback. Em produção use HTTPS em proxy reverso.'));
    }
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        sweeper = setInterval(sweep, 15000);
        sweeper.unref();
        resolve(server.address());
      });
    });
  }

  function close() {
    if (sweeper) clearInterval(sweeper);
    for (const code of [...waiters.keys()]) {
      for (const r of ROLES) { const w = dropWaiter(code, r); if (w) sendJson(w.res, 503, { ok: false, error: 'shutting_down' }, w.cors); }
    }
    return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  return { server, listen, close, sweep, stats: () => ({ rooms: rooms.size, waiters: waiterCount }) };
}

// Fonte CSP do script inline do index.html. O navegador normaliza CRLF para LF dentro do <script>; se o arquivo vier com CRLF
// (checkout no Windows com autocrlf, como no GitHub Actions), o hash do texto cru não bate e a CSP bloqueia o script (a tela
// fica sem menu). Por isso o texto é normalizado antes de calcular o hash.
function inlineScriptSource(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (script === undefined) return '';
  return ` 'sha256-${crypto.createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64')}'`;
}

module.exports = { createRoomService, DEFAULTS, PROTOCOL_VERSION, inlineScriptSource };
