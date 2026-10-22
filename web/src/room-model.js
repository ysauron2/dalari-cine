/* Modelo de sala do Dalari Cine: identidade por criação/entrada e validação estrita de mensagens.
   Formato UMD: <script src> no navegador e require() no Node.

   ATENÇÃO: isto é um MODELO DE PROTOCOLO, não admissão segura. Não há rede, servidor nem
   persistência. As garantias abaixo (convite de uso único, expiração, vaga única de convidado,
   anti-replay) só valem de verdade quando UM servidor confiável guardar este estado, comparar
   as credenciais por lá (armazenando-as como hash) e limitar tentativas de entrada. Nada aqui
   foi auditado e nada aqui implementa criptografia própria: a aleatoriedade vem somente de
   crypto.getRandomValues / crypto.randomFillSync da plataforma (nunca Math.random).

   Papéis canônicos no fio: 'host' (quem criou a sala, Pessoa 1) e 'guest' (quem entrou pelo
   convite, Pessoa 2). O papel é derivado da credencial, nunca declarado pela mensagem.
   Mapeamento legado do protótipo local: host = 'you', guest = 'partner'. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLES = ['host', 'guest'];
  const LEGACY_ROLE_MAP = { host: 'you', guest: 'partner' };
  const LIMITS = {
    secretBytes: 32,              // 256 bits por credencial/segredo de convite
    codeDigits: 6,                // código público de exibição (NÃO é segredo)
    inviteTtlMs: 15 * 60 * 1000,  // validade padrão do convite
    roomTtlMs: 4 * 60 * 60 * 1000,
    maxMessageBytes: 2048,        // UTF-8 da mensagem serializada
    maxSeq: 2147483647,
    maxStringLen: 64,
    maxListItems: 3,
  };
  const ENVELOPE_KEYS = ['v', 'room', 'type', 'seq', 'payload'];
  const FORBIDDEN_IDENTITY_KEYS = ['role', 'from', 'sender', 'identity', 'who', 'user', 'host', 'guest'];
  const PROTOCOL_VERSION = 1;

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const isStr = (v, max = LIMITS.maxStringLen) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const exactKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => has(o, k));

  // Validadores de payload por tipo. `roles` restringe quem pode enviar.
  const TYPES = {
    vote: {
      roles: ROLES,
      check: (p) => isPlain(p) && exactKeys(p, ['titleId', 'vote']) && isStr(p.titleId) && (p.vote === 'yes' || p.vote === 'no'),
    },
    round: { // só o host abre rodadas (política provisória do modelo)
      roles: ['host'],
      check: (p) => isPlain(p) && exactKeys(p, ['titleIds']) && Array.isArray(p.titleIds) &&
        p.titleIds.length >= 1 && p.titleIds.length <= LIMITS.maxListItems && p.titleIds.every((t) => isStr(t)),
    },
    playback: {
      roles: ROLES,
      check: (p) => isPlain(p) && exactKeys(p, ['action', 'positionSec']) && ['play', 'pause', 'seek'].includes(p.action) &&
        typeof p.positionSec === 'number' && Number.isFinite(p.positionSec) && p.positionSec >= 0 && p.positionSec <= 86400,
    },
    history: {
      roles: ROLES,
      check: (p) => isPlain(p) && exactKeys(p, ['titleId', 'progress']) && isStr(p.titleId) &&
        Number.isInteger(p.progress) && p.progress >= 0 && p.progress <= 100,
    },
  };

  const fail = (reason) => ({ ok: false, reason });

  function platformRandomBytes(n) {
    const out = new Uint8Array(n);
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (c && typeof c.getRandomValues === 'function') { c.getRandomValues(out); return out; }
    if (typeof require === 'function') {
      try { const nc = require('node:crypto'); nc.randomFillSync(out); return out; } catch (e) { /* cai no erro abaixo */ }
    }
    throw new Error('Sem fonte criptográfica segura de números aleatórios; recusando gerar credenciais.');
  }

  function toBase64Url(bytes) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
    }
    return s.slice(0, Math.ceil((bytes.length * 8) / 6));
  }

  // Comparação de modelo; o serviço real deve comparar hashes com primitivas da plataforma.
  function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  function utf8Length(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
    }
    return n;
  }

  /* createRoom({ now, randomBytes, inviteTtlMs, roomTtlMs })
     now: () => ms (injetável). randomBytes: (n) => Uint8Array de n bytes (injetável só em testes).
     Retorna { room, code, hostCredential, inviteSecret }. Entregue hostCredential só ao criador e
     inviteSecret só dentro do convite real; nunca os coloque em mensagens, logs ou localStorage. */
  function createRoom(opts = {}) {
    const now = opts.now || (() => Date.now());
    const rand = opts.randomBytes || platformRandomBytes;
    const inviteTtlMs = opts.inviteTtlMs ?? LIMITS.inviteTtlMs;
    const roomTtlMs = opts.roomTtlMs ?? LIMITS.roomTtlMs;
    if (!(inviteTtlMs > 0) || !(roomTtlMs > 0)) throw new Error('TTL inválido.');

    const bytes = (n) => {
      const b = rand(n);
      if (!(b instanceof Uint8Array) || b.length !== n) throw new Error('randomBytes deve devolver Uint8Array do tamanho pedido.');
      return b;
    };
    const secret = () => toBase64Url(bytes(LIMITS.secretBytes));
    const code = (() => { // rejeição de viés: 4 bytes -> só aceita abaixo do maior múltiplo de 1e6
      const limit = 4294967296 - (4294967296 % 1000000);
      for (let i = 0; i < 16; i++) {
        const b = bytes(4);
        const v = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
        if (v < limit) return String(v % 1000000).padStart(LIMITS.codeDigits, '0');
      }
      throw new Error('Fonte aleatória inválida.');
    })();

    const hostCredential = secret();
    const inviteSecret = secret();
    if (sameSecret(hostCredential, inviteSecret)) throw new Error('Fonte aleatória inválida: credenciais repetidas.');

    const createdAt = now();
    const inviteExpiresAt = createdAt + inviteTtlMs;
    const roomExpiresAt = createdAt + roomTtlMs;
    let guestCredential = null;
    let inviteConsumed = false;
    const lastSeq = { host: 0, guest: 0 };

    const roomExpired = () => now() >= roomExpiresAt;

    function roleOf(credential) {
      if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) return null;
      // avalia as duas comparações sempre, sem curto-circuito entre papéis
      const isHost = sameSecret(credential, hostCredential);
      const isGuest = guestCredential !== null && sameSecret(credential, guestCredential);
      return isHost ? 'host' : isGuest ? 'guest' : null;
    }

    function join(input = {}) {
      if (roomExpired()) return fail('room_expired');
      const c = isPlain(input) ? input.code : undefined;
      const s = isPlain(input) ? input.inviteSecret : undefined;
      // código e segredo são verificados antes de revelar qualquer estado da sala
      const codeOk = typeof c === 'string' && /^\d{6}$/.test(c) && sameSecret(c, code);
      const secretOk = typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s) && sameSecret(s, inviteSecret);
      if (!(codeOk && secretOk)) return fail('invalid_invite');
      if (inviteConsumed) return fail('room_full');
      if (now() >= inviteExpiresAt) return fail('invite_expired');
      inviteConsumed = true;
      guestCredential = secret();
      if (sameSecret(guestCredential, hostCredential)) { guestCredential = null; inviteConsumed = false; throw new Error('Fonte aleatória inválida: credenciais repetidas.'); }
      const joined = { ok: true, role: 'guest' };
      Object.defineProperty(joined, 'guestCredential', { value: guestCredential, enumerable: false });
      return joined;
    }

    function receive(credential, raw) {
      if (roomExpired()) return fail('room_expired');
      const role = roleOf(credential);
      if (!role) return fail('unauthenticated');

      let text;
      if (typeof raw === 'string') text = raw;
      else if (isPlain(raw)) { try { text = JSON.stringify(raw); } catch (e) { return fail('malformed'); } }
      else return fail('malformed');
      if (typeof text !== 'string' || utf8Length(text) > LIMITS.maxMessageBytes) return fail('too_large');

      let msg;
      try { msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(text); } catch (e) { return fail('malformed'); }
      if (!isPlain(msg)) return fail('malformed');
      if (FORBIDDEN_IDENTITY_KEYS.some((k) => has(msg, k))) return fail('declared_identity');
      if (!exactKeys(msg, ENVELOPE_KEYS)) return fail('malformed');
      if (msg.v !== PROTOCOL_VERSION) return fail('bad_version');
      if (msg.room !== code) return fail('wrong_room');
      if (typeof msg.type !== 'string' || !has(TYPES, msg.type)) return fail('unknown_type');
      const spec = TYPES[msg.type];
      if (!spec.roles.includes(role)) return fail('wrong_role');
      if (!Number.isInteger(msg.seq) || msg.seq < 1 || msg.seq > LIMITS.maxSeq) return fail('bad_seq');
      if (msg.seq <= lastSeq[role]) return fail('stale_seq');
      if (!spec.check(msg.payload)) return fail('bad_payload');

      lastSeq[role] = msg.seq; // só avança após validação completa
      return { ok: true, role, type: msg.type, seq: msg.seq, payload: msg.payload };
    }

    // Visão pública, segura para log/UI: sem nenhuma credencial ou segredo de convite.
    function describe() {
      return {
        code, guestJoined: guestCredential !== null, inviteConsumed,
        inviteExpiresAt, roomExpiresAt, expired: roomExpired(),
        inviteExpired: !inviteConsumed && now() >= inviteExpiresAt,
      };
    }

    const room = Object.freeze({ join, receive, roleOf, describe, toJSON: describe });
    const created = { room, code };
    Object.defineProperties(created, {
      hostCredential: { value: hostCredential, enumerable: false },
      inviteSecret: { value: inviteSecret, enumerable: false },
    });
    return created;
  }

  /* Monta um envelope para enviar. Sem papel/remetente: o receptor deduz pela credencial. */
  function makeMessage(room, seq, type, payload) {
    return JSON.stringify({ v: PROTOCOL_VERSION, room, type, seq, payload });
  }

  return { createRoom, makeMessage, ROLES, LEGACY_ROLE_MAP, LIMITS, PROTOCOL_VERSION, MESSAGE_TYPES: Object.keys(TYPES) };
});
