// Protocolo da ponte Dalari Cine <-> Netflix. Puro: sem DOM, sem chrome.*, sem rede.
// Todas as fronteiras (aba da sala, extensao, aba Netflix) validam as mensagens com ESTE modulo:
// chaves exatas, tipos, limites e versao. Nada aqui carrega credenciais da sala: o snapshot que
// atravessa a ponte e reconstruido campo a campo (sanitizeSnapshot) e nunca contem voz/SDP/tokens.
(function (root) {
  "use strict";

  const V = 1;
  const MAX_POSITION_SEC = 86400;
  const WATCH_ID_RE = /^[0-9]{1,12}$/;
  const CODE_RE = /^[0-9]{6}$/;
  const ROLE_RE = /^(host|guest|guest2|guest3)$/;
  const TITLE_ID_RE = /^[A-Za-z0-9:_-]{1,80}$/;
  const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
  const ACTIONS = Object.freeze(["play", "pause", "seek"]);
  const NETFLIX_ORIGIN = "https://www.netflix.com";
  // Origens onde a aba da sala pode se registrar. Producao: acrescentar a origem HTTPS real do Dalari Cine
  // (e o mesmo padrao em manifest.json). Hoje so loopback, para teste local.
  const ROOM_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/;
  const STATUS_STATES = Object.freeze(["idle", "applied", "autoplay-blocked", "blocked-no-video", "blocked-wrong-watch", "play-failed", "pause-failed", "seek-failed", "send-failed", "room-not-active", "context-changed", "synced", "waiting"]);

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const exactKeys = (o, keys) => isPlain(o) && Object.keys(o).length === keys.length && keys.every((k) => has(o, k));
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const isStr = (v, re) => typeof v === "string" && re.test(v);
  const isPos = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_POSITION_SEC;

  function sanitizeMedia(media) {
    if (media === null || media === undefined) return null;
    if (!isPlain(media) || media.provider !== "netflix" || !isStr(media.titleId, TITLE_ID_RE) || !isStr(media.watchId, WATCH_ID_RE)) return undefined;
    return { provider: "netflix", titleId: media.titleId, watchId: media.watchId };
  }

  function sanitizePlayback(pb) {
    if (pb === null || pb === undefined) return null;
    if (!isPlain(pb) || !isStr(pb.titleId, TITLE_ID_RE) || !isStr(pb.watchId, WATCH_ID_RE)) return undefined;
    if (pb.state !== "playing" && pb.state !== "paused") return undefined;
    if (!isPos(pb.positionSec) || !Number.isFinite(pb.updatedAt) || !isInt(pb.version, 1, 2147483647)) return undefined;
    return { titleId: pb.titleId, watchId: pb.watchId, state: pb.state, positionSec: pb.positionSec, updatedAt: pb.updatedAt, version: pb.version };
  }

  // Reconstroi a visao minima da sala que a aba Netflix precisa. Devolve null se algo estiver fora do contrato.
  function sanitizeSnapshot(raw, expected) {
    try {
      if (!isPlain(raw) || raw.v !== 1) return null;
      if (!isStr(raw.code, CODE_RE) || !isStr(raw.you, ROLE_RE)) return null;
      if (expected && (raw.code !== expected.code || raw.you !== expected.you)) return null;
      if (!isInt(raw.revision, 0, Number.MAX_SAFE_INTEGER) || typeof raw.serverTime !== "number" || !Number.isFinite(raw.serverTime)) return null;
      if (typeof raw.status !== "string" || raw.status.length > 32) return null;
      const platform = raw.platform === null || raw.platform === undefined ? null : (typeof raw.platform === "string" && raw.platform.length <= 16 ? raw.platform : undefined);
      if (platform === undefined) return null;
      const media = sanitizeMedia(raw.media);
      const playback = sanitizePlayback(raw.playback);
      if (media === undefined || playback === undefined) return null;
      const selectedMatch = raw.selectedMatch === null || raw.selectedMatch === undefined ? null : (isStr(raw.selectedMatch, TITLE_ID_RE) ? raw.selectedMatch : undefined);
      if (selectedMatch === undefined) return null;
      return { v: 1, code: raw.code, you: raw.you, revision: raw.revision, serverTime: raw.serverTime, status: raw.status, platform, selectedMatch, media, playback };
    } catch (_error) {
      return null;
    }
  }

  const tabEntry = (t) => exactKeys(t, ["tabId", "watchId", "bound", "mine"]) && isInt(t.tabId, 0, 2147483647) && isStr(t.watchId, WATCH_ID_RE) && typeof t.bound === "boolean" && typeof t.mine === "boolean";

  // Cada tipo: direcao permitida e validador dos campos (alem de v/type).
  const SPECS = {
    "room.hello": { dir: "room->hub", keys: ["code", "you"], check: (m) => isStr(m.code, CODE_RE) && isStr(m.you, ROLE_RE) },
    "room.snapshot": { dir: "room->hub", keys: ["snapshot"], check: (m) => sanitizeSnapshot(m.snapshot) !== null },
    "room.bind": { dir: "room->hub", keys: ["tabId", "watchId", "titleId"], check: (m) => isInt(m.tabId, 0, 2147483647) && isStr(m.watchId, WATCH_ID_RE) && isStr(m.titleId, TITLE_ID_RE) },
    "room.unbind": { dir: "room->hub", keys: [], check: () => true },
    "room.ack": { dir: "room->hub", keys: ["id", "ok"], check: (m) => isStr(m.id, EVENT_ID_RE) && typeof m.ok === "boolean" },
    "room.ping": { dir: "room->hub", keys: [], check: () => true },
    "room.refresh": { dir: "room->hub", keys: [], check: () => true },
    "hub.tabs": { dir: "hub->room", keys: ["tabs"], check: (m) => Array.isArray(m.tabs) && m.tabs.length <= 16 && m.tabs.every(tabEntry) },
    "hub.bound": { dir: "hub->room", keys: ["tabId", "watchId"], check: (m) => isInt(m.tabId, 0, 2147483647) && isStr(m.watchId, WATCH_ID_RE) },
    "hub.unbound": { dir: "hub->room", keys: ["reason"], check: (m) => typeof m.reason === "string" && /^[a-z_]{1,32}$/.test(m.reason) },
    "hub.bindError": { dir: "hub->room", keys: ["reason"], check: (m) => typeof m.reason === "string" && /^[a-z_]{1,32}$/.test(m.reason) },
    "hub.event": { dir: "hub->room", keys: ["id", "tabId", "titleId", "watchId", "action", "positionSec"], check: (m) => isStr(m.id, EVENT_ID_RE) && isInt(m.tabId, 0, 2147483647) && isStr(m.titleId, TITLE_ID_RE) && isStr(m.watchId, WATCH_ID_RE) && ACTIONS.includes(m.action) && isPos(m.positionSec) },
    "hub.status": { dir: "hub->room", keys: ["tabId", "state", "watchId"], check: (m) => isInt(m.tabId, 0, 2147483647) && STATUS_STATES.includes(m.state) && isStr(m.watchId, WATCH_ID_RE) },
    "hub.pong": { dir: "hub->room", keys: [], check: () => true },
    "netflix.hello": { dir: "netflix->hub", keys: ["watchId"], check: (m) => isStr(m.watchId, WATCH_ID_RE) },
    "netflix.event": { dir: "netflix->hub", keys: ["id", "titleId", "watchId", "action", "positionSec"], check: (m) => isStr(m.id, EVENT_ID_RE) && isStr(m.titleId, TITLE_ID_RE) && isStr(m.watchId, WATCH_ID_RE) && ACTIONS.includes(m.action) && isPos(m.positionSec) },
    "netflix.status": { dir: "netflix->hub", keys: ["state", "watchId"], check: (m) => STATUS_STATES.includes(m.state) && isStr(m.watchId, WATCH_ID_RE) },
    "netflix.bind": { dir: "hub->netflix", keys: ["code", "you", "titleId", "watchId"], check: (m) => isStr(m.code, CODE_RE) && isStr(m.you, ROLE_RE) && isStr(m.titleId, TITLE_ID_RE) && isStr(m.watchId, WATCH_ID_RE) },
    "netflix.snapshot": { dir: "hub->netflix", keys: ["snapshot"], check: (m) => sanitizeSnapshot(m.snapshot) !== null },
    "netflix.unbind": { dir: "hub->netflix", keys: [], check: () => true },
    "netflix.ack": { dir: "hub->netflix", keys: ["id", "ok"], check: (m) => isStr(m.id, EVENT_ID_RE) && typeof m.ok === "boolean" },
  };

  /** Valida uma mensagem recebida. `dir` e a direcao esperada pelo receptor, ex.: "room->hub". */
  function validate(message, dir) {
    try {
      if (!isPlain(message)) return { ok: false, reason: "shape" };
      if (message.v !== V) return { ok: false, reason: "version" };
      if (typeof message.type !== "string" || !has(SPECS, message.type)) return { ok: false, reason: "type" };
      const spec = SPECS[message.type];
      if (spec.dir !== dir) return { ok: false, reason: "direction" };
      if (!exactKeys(message, ["v", "type", ...spec.keys])) return { ok: false, reason: "keys" };
      if (!spec.check(message)) return { ok: false, reason: "fields" };
      return { ok: true };
    } catch (_error) {
      return { ok: false, reason: "shape" };
    }
  }

  function isRoomOrigin(origin) { return typeof origin === "string" && ROOM_ORIGIN_RE.test(origin); }
  function isNetflixWatchUrl(href) {
    try {
      const u = new URL(href);
      return u.origin === NETFLIX_ORIGIN && /^\/watch\/[0-9]{1,12}\/?$/.test(u.pathname);
    } catch (_error) { return false; }
  }
  function netflixWatchIdFromUrl(href) {
    try {
      const u = new URL(href);
      const m = u.origin === NETFLIX_ORIGIN ? /^\/watch\/([0-9]{1,12})\/?$/.exec(u.pathname) : null;
      return m ? m[1] : null;
    } catch (_error) { return null; }
  }
  const netflixWatchUrl = (watchId) => (isStr(watchId, WATCH_ID_RE) ? `${NETFLIX_ORIGIN}/watch/${watchId}` : null);

  const api = Object.freeze({
    V, WATCH_ID_RE, CODE_RE, ROLE_RE, TITLE_ID_RE, EVENT_ID_RE, NETFLIX_ORIGIN, ROOM_ORIGIN_RE, STATUS_STATES,
    validate, sanitizeSnapshot, isRoomOrigin, isNetflixWatchUrl, netflixWatchIdFromUrl, netflixWatchUrl,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DuoTelaBridgeProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
