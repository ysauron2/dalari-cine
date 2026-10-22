/* Código curto de uso único para abrir a conexão direta (p2p-link.js) sem copiar e colar códigos grandes.
   O Host mostra um código como K7QM-93XP. Os dois aparelhos derivam dele, com PBKDF2, dois "tópicos" e uma chave AES.
   O convidado publica a oferta de conexão (criptografada) num tópico; o Host, que já escuta, responde (criptografado) no
   outro. O relé (ntfy.sh por padrão) só transporta texto cifrado e não vê o código nem o conteúdo. Sem o código não se acha
   o tópico, nem se lê, nem se forja mensagem. O código vale para UM pareamento: o Host só aceita a primeira oferta válida
   e ele expira em 15 minutos. O convite da sala continua sendo de uso único e o Host continua aprovando cada entrada. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoRendezvous = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';      // Crockford base32: sem I, L, O, U
  const CODE_LEN = 8;                                        // 40 bits; com PBKDF2 não dá para tentar todos
  const PBKDF2_ITER = 200000;
  const TTL_MS = 15 * 60 * 1000;
  const DEFAULT_RELAY = 'https://ntfy.sh';

  const enc = new TextEncoder(), dec = new TextDecoder();
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const fromB64 = (t) => { const b = atob(t.replace(/-/g, '+').replace(/_/g, '/')); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };
  const hex = (u8) => [...u8].map((n) => n.toString(16).padStart(2, '0')).join('');

  /** Gera um código novo: 8 caracteres, mostrado como XXXX-XXXX. */
  function newCode(cryptoImpl = globalThis.crypto) {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(CODE_LEN));
    const raw = [...bytes].map((b) => ALPHABET[b & 31]).join('');
    return raw.slice(0, 4) + '-' + raw.slice(4);
  }
  /** Aceita minúsculas, espaços, hífen e as confusões O→0, I/L→1. Devolve os 8 caracteres ou null. */
  function normalizeCode(text) {
    const raw = String(text ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return raw.length === CODE_LEN && [...raw].every((c) => ALPHABET.includes(c)) ? raw : null;
  }
  const looksLikeShortCode = (text) => normalizeCode(text) !== null && !/^DT[12]\./i.test(String(text).trim());

  async function deriveKeys(code, subtle = globalThis.crypto?.subtle) {
    const norm = normalizeCode(code);
    if (!norm) throw new Error('Código inválido.');
    if (!subtle) throw new Error('Este navegador não oferece criptografia aqui (use 127.0.0.1, localhost ou https).');
    const base = await subtle.importKey('raw', enc.encode('duotela-pair:' + norm), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('duotela-rendezvous-v1'), iterations: PBKDF2_ITER }, base, 64 * 8));
    const key = await subtle.importKey('raw', bits.slice(32, 64), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { toHost: 'duo-' + hex(bits.slice(0, 16)), toGuest: 'duo-' + hex(bits.slice(16, 32)), key };
  }

  /** Código de reencontro: derivado do código usado no pareamento e do número da sala, igual nos dois lados e sem trafegar nada.
      Serve para religar a conexão direta se ela cair, sem pedir outro código à pessoa. Não é o código original (tópicos diferentes). */
  async function deriveReconnectCode(code, room, subtle = globalThis.crypto?.subtle) {
    const norm = normalizeCode(code);
    if (!norm || !/^\d{6}$/.test(String(room))) throw new Error('Código inválido.');
    if (!subtle) throw new Error('Este navegador não oferece criptografia aqui (use 127.0.0.1, localhost ou https).');
    const digest = new Uint8Array(await subtle.digest('SHA-256', enc.encode('duotela-reconnect-v1:' + norm + ':' + room)));
    const raw = [...digest.slice(0, CODE_LEN)].map((b) => ALPHABET[b & 31]).join('');
    return raw.slice(0, 4) + '-' + raw.slice(4);
  }

  async function seal(key, obj, subtle = globalThis.crypto.subtle) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return toB64(out);
  }
  /** Devolve o objeto ou null (mensagem de outra origem, adulterada ou de outro código). */
  async function open(key, text, subtle = globalThis.crypto.subtle) {
    try {
      const b = fromB64(String(text).trim());
      if (b.length < 29 || b.length > 6000) return null;
      return JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12))));
    } catch { return null; }
  }

  /** Cliente mínimo do relé (API do ntfy): publicar texto e escutar um tópico em tempo real. */
  class Relay {
    constructor({ baseUrl = DEFAULT_RELAY, fetchImpl } = {}) {
      const u = new URL(baseUrl);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('O relé precisa ser https.');
      this.base = u.origin;
      this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    }
    async publish(topic, text) {
      const res = await this.fetch(`${this.base}/${topic}`, { method: 'POST', body: text, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('O serviço de encontro recusou a mensagem (' + res.status + ').');
    }
    /** Escuta até abortar. `ready` resolve quando o relé confirma a inscrição; onMessage(texto) recebe cada mensagem. */
    subscribe(topic, onMessage, { signal, since = '2m' } = {}) {
      let markReady; const ready = new Promise((r) => { markReady = r; });
      const done = (async () => {
        const res = await this.fetch(`${this.base}/${topic}/json?since=${since}`, { signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!res.ok || !res.body) throw new Error('Não foi possível falar com o serviço de encontro (' + res.status + ').');
        markReady();
        const reader = res.body.getReader(); let buf = '';
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev && ev.event === 'message' && typeof ev.message === 'string') onMessage(ev.message);
          }
        }
      })();
      done.catch(() => {});
      return { ready: Promise.race([ready, done]), done };
    }
  }

  /** Host: escuta o código; ao chegar a PRIMEIRA oferta válida e ainda dentro do prazo, responde e encerra (uso único).
      respond(offerCode) -> { answer, extra? } ; devolve { stop(), result } onde result resolve quando houve resposta. */
  function hostListen({ code, relay, respond, now = () => Date.now(), seen = null }) {
    const ctl = new AbortController();
    const expiresAt = now() + TTL_MS;
    let stopped = false;
    const result = (async () => {
      const keys = await deriveKeys(code);
      let handled = false;
      const queue = [];
      const sub = relay.subscribe(keys.toHost, (m) => queue.push(m), { signal: ctl.signal });
      const finish = new Promise((resolve, reject) => {
        const tick = setInterval(async () => {
          try {
            if (now() > expiresAt && !handled) { clearInterval(tick); ctl.abort(); reject(new Error('O código expirou.')); return; }
            while (queue.length && !handled) {
              const msg = await open(keys.key, queue.shift());
              if (!msg || msg.t !== 'offer' || typeof msg.c !== 'string' || !(msg.exp > now())) continue;   // lixo, repetida ou vencida
              if (seen && (seen.has(msg.n) || seen.size > 1000)) continue;      // oferta que este Host já atendeu antes (o relé repete mensagens recentes)
              if (seen) seen.add(msg.n);
              handled = true;                                                                                // uso único: a primeira vale
              clearInterval(tick);
              const out = await respond(msg.c);
              await relay.publish(keys.toGuest, await seal(keys.key, { t: 'answer', c: out.answer, x: out.extra, n: msg.n, exp: now() + TTL_MS }));
              ctl.abort(); resolve(out);
            }
          } catch (e) { clearInterval(tick); ctl.abort(); reject(e); }
        }, 150);
        ctl.signal.addEventListener('abort', () => { if (!handled) { clearInterval(tick); if (stopped) resolve(null); } });
      });
      await sub.ready;
      return finish;
    })();
    result.catch(() => {});
    return { stop() { stopped = true; ctl.abort(); }, result };
  }

  /** Convidado: publica a oferta e espera a resposta do Host. Devolve { answer, extra } ou lança erro. */
  async function guestPair({ code, relay, offer, timeoutMs = 60000, now = () => Date.now() }) {
    const keys = await deriveKeys(code);
    const ctl = new AbortController();
    const nonce = toB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));   // amarra a resposta a ESTA oferta (o relé repete mensagens recentes)
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ctl.abort(); reject(new Error('O Host não respondeu. O código pode ter expirado, já ter sido usado, ou o Host fechou a janela.')); }, timeoutMs);
      const sub = relay.subscribe(keys.toGuest, async (m) => {
        const msg = await open(keys.key, m);
        if (!msg || msg.t !== 'answer' || msg.n !== nonce || typeof msg.c !== 'string' || !(msg.exp > now())) return;
        clearTimeout(timer); ctl.abort(); resolve({ answer: msg.c, extra: msg.x });
      }, { signal: ctl.signal });
      sub.done.catch((e) => { if (e?.name !== 'AbortError') { clearTimeout(timer); reject(e); } });
      sub.ready.then(async () => {
        try { await relay.publish(keys.toHost, await seal(keys.key, { t: 'offer', c: offer, n: nonce, exp: now() + TTL_MS })); }
        catch (e) { clearTimeout(timer); ctl.abort(); reject(e); }
      }, () => {});
    });
    return got;
  }

  // Convite com um toque: um link https (página docs/entrar do repositório, no GitHub Pages) que abre o app. O código vai só depois do "#",
  // parte que o navegador nunca envia a servidor nenhum.
  const INVITE_PAGE = 'https://ysauron2.github.io/dalari-cine/entrar/';
  const DOWNLOAD_PAGE = 'https://github.com/ysauron2/dalari-cine/releases/latest';
  const inviteLink = (code) => { const n = normalizeCode(code); return n ? INVITE_PAGE + '#' + n.slice(0, 4) + '-' + n.slice(4) : null; };
  /** A mensagem pronta para colar no WhatsApp ou onde for: link, código para digitar e onde baixar o app. */
  function inviteMessage(code, hostName) {
    const link = inviteLink(code);
    if (!link) return null;
    const n = normalizeCode(code), shown = n.slice(0, 4) + '-' + n.slice(4);
    const who = typeof hostName === 'string' && hostName.trim() ? hostName.trim().slice(0, 32) + ' te chamou' : 'Te chamaram';
    return who + ' para ver um filme juntos no Dalari Cine! ' + String.fromCodePoint(0x1F3AC) + '\n\n'
      + 'Toque para entrar: ' + link + '\n\n'
      + 'Se o app pedir, o código é ' + shown + ' (vale 15 minutos).\n'
      + 'Ainda não tem o app? Baixe aqui: ' + DOWNLOAD_PAGE;
  }

  return { newCode, normalizeCode, looksLikeShortCode, inviteLink, inviteMessage, INVITE_PAGE, DOWNLOAD_PAGE, deriveKeys, deriveReconnectCode, seal, open, Relay, hostListen, guestPair, DEFAULT_RELAY, TTL_MS, ALPHABET };
});
