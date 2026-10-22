/* Conexão direta entre dois aparelhos, sem servidor de encontro: os dois lados trocam um código de oferta e um de
   resposta (por qualquer canal, como WhatsApp) e abrem um canal WebRTC. Por esse canal o convidado fala com o serviço
   da sala que roda no aparelho do Host: o Host executa, contra o próprio serviço local, só as rotas da sala que
   um convidado precisa, e devolve a resposta. O serviço continua sendo quem autentica (tokens e convite). A voz usa
   a negociação normal da sala; só o áudio sai pela internet, direto entre os aparelhos. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoP2P = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFIX = 'DT1.';            // formato completo (SDP inteiro)
  const PREFIX2 = 'DT2.';           // formato compacto (~110 caracteres)
  const MAX_CODE = 16384;
  const CHUNK = 12000;                 // caracteres por mensagem do canal (bem abaixo do limite do SCTP)
  const MAX_BODY = 40000;              // corpo de requisição do convidado
  const MAX_RESPONSE = 262144;
  const MAX_INFLIGHT = 8;
  const REQUEST_TIMEOUT_MS = 40000;
  const ICE_WAIT_MS = 4000;           // a coleta de candidatos pode demorar com várias placas de rede; segue com o que houver

  // Rotas que um convidado pode chamar no serviço do Host. Criar sala, admissão, convite e encerramento são do Host.
  function isAllowedGuestRoute(method, path) {
    if (typeof path !== 'string' || path.length > 300) return false;
    if (method === 'GET') return /^\/v1\/rooms\/\d{6}\/(?:state\?after=\d{1,9}&wait=\d{1,2}|ice|youtube\/search\?q=[^#\s]{2,240})$/.test(path);
    if (method === 'POST') return /^\/v1\/rooms\/\d{6}\/(?:join|actions|profile|leave)$/.test(path);
    return false;
  }

  function bytesToB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlToBytes(text) {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /** type: 'offer' | 'answer'. extra: objeto JSON pequeno (ex.: o convite da sala). */
  function encodeCode(type, sdp, extra) {
    const body = { v: 1, t: type === 'offer' ? 'o' : 'a', s: sdp };
    if (extra !== undefined) body.x = extra;
    return PREFIX + bytesToB64url(new TextEncoder().encode(JSON.stringify(body)));
  }
  // ---- formato compacto (DT2): só o que o SDP de um canal de dados tem de essencial ----
  // fingerprint DTLS (32 bytes), ufrag, senha ICE, até 5 candidatos UDP (IP e porta) e, na oferta, o código da sala.
  // O resto do SDP é sempre igual e é reconstruído no destino. Se o SDP tiver algo inesperado, usa-se o formato completo.
  const CAND_TYPES = ['host', 'srflx', 'relay'];
  const TYPE_PREF = { host: 126, srflx: 100, relay: 0 };
  const isIpv4 = (a) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(a) && a.split('.').every((n) => Number(n) <= 255);
  const ipv6Groups = (a) => {
    if (!/^[0-9a-fA-F:]+$/.test(a) || a.split('::').length > 2) return null;
    const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    if (tail === null ? h.length !== 8 : h.length + t.length > 7) return null;
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
  };
  function parseSdpEssentials(sdp) {
    const one = (re) => { const m = re.exec(sdp); return m ? m[1].trim() : null; };
    const ufrag = one(/^a=ice-ufrag:(.+)$/m), pwd = one(/^a=ice-pwd:(.+)$/m), fp = one(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)$/m);
    if (!ufrag || !pwd || !fp || !/^[\x21-\x7e]{4,255}$/.test(ufrag) || !/^[\x21-\x7e]{22,255}$/.test(pwd)) return null;
    const fingerprint = fp.split(':').map((h) => parseInt(h, 16));
    if (fingerprint.length !== 32 || fingerprint.some((n) => !(n >= 0 && n <= 255))) return null;
    if (!/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel/m.test(sdp)) return null;
    const cands = [], seen = new Set();
    for (const m of sdp.matchAll(/^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (host|srflx|relay)\b/gm)) {
      const [, addr, port, type] = m;
      const key = addr + ':' + port;
      if (seen.has(key) || Number(port) > 65535) continue;
      const v4 = isIpv4(addr), v6 = !v4 && ipv6Groups(addr);
      if (!v4 && !v6 && !/^[A-Za-z0-9.-]{1,80}$/.test(addr)) continue;
      if (v6 && /^fe80:/i.test(addr)) continue;          // link-local não serve a outro aparelho
      seen.add(key); cands.push({ addr, port: Number(port), type, v4, v6: !!v6 });
    }
    cands.sort((a, b) => (b.type === 'srflx') - (a.type === 'srflx') || b.v4 - a.v4);
    if (!cands.length) return null;
    return { ufrag, pwd, fingerprint, cands: cands.slice(0, 5) };
  }
  function encodeCompact(type, sdp, extra) {
    const e = parseSdpEssentials(sdp);
    if (!e) return null;
    const room = extra && typeof extra.room === 'string' ? extra.room : null;
    if (extra !== undefined && (!room || !/^\d{6}$/.test(room) || Object.keys(extra).length !== 1)) return null;
    const out = [type === 'offer' ? 0x40 : 0x41, ...e.fingerprint, e.ufrag.length, ...[...e.ufrag].map((c) => c.charCodeAt(0)), e.pwd.length, ...[...e.pwd].map((c) => c.charCodeAt(0)), e.cands.length];
    for (const c of e.cands) {
      const flags = CAND_TYPES.indexOf(c.type) | (c.v6 ? 4 : 0) | (!c.v4 && !c.v6 ? 8 : 0);
      out.push(flags);
      if (c.v4) out.push(...c.addr.split('.').map(Number));
      else if (c.v6) for (const g of ipv6Groups(c.addr)) out.push(g >> 8, g & 255);
      else out.push(c.addr.length, ...[...c.addr].map((ch) => ch.charCodeAt(0)));
      out.push(c.port >> 8, c.port & 255);
    }
    if (room) { const n = Number(room); out.push(1, (n >> 16) & 255, (n >> 8) & 255, n & 255); } else out.push(0);
    return PREFIX2 + bytesToB64url(Uint8Array.from(out));
  }
  function decodeCompact(raw) {
    let b;
    try { b = b64urlToBytes(raw.slice(PREFIX2.length)); } catch { throw new Error('Código de conexão inválido.'); }
    let i = 0;
    const need = (n) => { if (i + n > b.length) throw new Error('Código de conexão inválido.'); };
    const take = (n) => { need(n); const v = b.subarray(i, i + n); i += n; return v; };
    const u8 = () => take(1)[0];
    const kind = u8();
    if (kind !== 0x40 && kind !== 0x41) throw new Error('Código de conexão inválido.');
    const fingerprint = [...take(32)].map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const str = (len) => String.fromCharCode(...take(len));
    const ufrag = str(u8()), pwd = str(u8());
    if (!/^[\x21-\x7e]{4,255}$/.test(ufrag) || !/^[\x21-\x7e]{22,255}$/.test(pwd)) throw new Error('Código de conexão inválido.');
    const count = u8();
    if (count < 1 || count > 8) throw new Error('Código de conexão inválido.');
    const cands = [];
    for (let k = 0; k < count; k++) {
      const flags = u8(), type = CAND_TYPES[flags & 3];
      if (!type || (flags & ~15)) throw new Error('Código de conexão inválido.');
      let addr;
      if (flags & 8) { addr = str(u8()); if (!/^[A-Za-z0-9.-]{1,80}$/.test(addr)) throw new Error('Código de conexão inválido.'); }
      else if (flags & 4) { const g = []; for (let j = 0; j < 8; j++) { const hi = u8(); g.push(((hi << 8) | u8()).toString(16)); } addr = g.join(':'); }
      else addr = [...take(4)].join('.');
      const port = (u8() << 8) | u8();
      cands.push({ addr, port, type });
    }
    let extra;
    if (u8() === 1) { const n = (u8() << 16) | (u8() << 8) | u8(); if (n > 999999) throw new Error('Código de conexão inválido.'); extra = { room: String(n).padStart(6, '0') }; }
    if (i !== b.length) throw new Error('Código de conexão inválido.');
    const first = cands.find((c) => isIpv4(c.addr)) || cands[0];
    const lines = ['v=0', 'o=- ' + (Date.now() * 1000 + 7) + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
      'm=application ' + first.port + ' UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 ' + (isIpv4(first.addr) ? first.addr : '0.0.0.0')];
    cands.forEach((c, n) => {
      const prio = (TYPE_PREF[c.type] * 16777216) + ((65535 - n) * 256) + 255;
      lines.push('a=candidate:' + (n + 1) + ' 1 udp ' + prio + ' ' + c.addr + ' ' + c.port + ' typ ' + c.type + (c.type === 'host' ? '' : ' raddr 0.0.0.0 rport 0') + ' generation 0 network-cost 999');
    });
    lines.push('a=ice-ufrag:' + ufrag, 'a=ice-pwd:' + pwd, 'a=ice-options:trickle', 'a=fingerprint:sha-256 ' + fingerprint,
      'a=setup:' + (kind === 0x40 ? 'actpass' : 'active'), 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144');
    return { type: kind === 0x40 ? 'offer' : 'answer', sdp: lines.join('\r\n') + '\r\n', extra };
  }
  /** Compacto quando possível; senão o formato completo. */
  function encodeAuto(type, sdp, extra) {
    return encodeCompact(type, sdp, extra) || encodeCode(type, sdp, extra);
  }

  function decodeCode(text) {
    const raw = String(text ?? '').replace(/\s+/g, '');
    if (raw.startsWith(PREFIX2)) {
      if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw.slice(PREFIX2.length))) throw new Error('Código de conexão inválido.');
      return decodeCompact(raw);
    }
    if (!raw.startsWith(PREFIX) || raw.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(raw.slice(PREFIX.length))) throw new Error('Código de conexão inválido.');
    let body;
    try { body = JSON.parse(new TextDecoder().decode(b64urlToBytes(raw.slice(PREFIX.length)))); }
    catch { throw new Error('Código de conexão inválido.'); }
    if (!body || body.v !== 1 || (body.t !== 'o' && body.t !== 'a') || typeof body.s !== 'string' || !body.s.startsWith('v=0') || body.s.length > 12000) throw new Error('Código de conexão inválido.');
    return { type: body.t === 'o' ? 'offer' : 'answer', sdp: body.s, extra: body.x };
  }
  const looksLikeCode = (text) => /^DT[12]\./.test(String(text ?? '').trim());

  function waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, ICE_WAIT_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  class P2PLink {
    /** iceServers: STUN (e TURN, se houver) para atravessar roteadores. */
    constructor({ iceServers = [], RTC, onState, onLog } = {}) {
      this.RTC = RTC || globalThis.RTCPeerConnection;
      if (typeof this.RTC !== 'function') throw new Error('Este navegador não oferece conexão direta.');
      this.iceServers = iceServers;
      this.onState = typeof onState === 'function' ? onState : () => {};
      this.onLog = typeof onLog === 'function' ? onLog : () => {};
      this.stats = { sent: 0, timed: 0, failed: 0, lastMs: 0, avgMs: 0, served: 0, rejected: 0 };   // túnel de requisições (painel de estatísticas)
      this.state = 'new';
      this.pc = null; this.channel = null;
      this.pending = new Map();        // lado convidado: id -> {resolve, reject, timer, parts}
      this.inflight = new Map();       // lado Host: id -> {abort, parts}
      this.nextId = 1;
      this.handler = null;
      this.opened = new Promise((resolve, reject) => { this.#resolveOpen = resolve; this.#rejectOpen = reject; });
      this.opened.catch(() => {});
    }
    #resolveOpen; #rejectOpen;

    #setState(state) {
      if (this.state === state || this.state === 'closed') return;
      this.state = state;
      this.onLog('conexão direta: ' + state);
      this.onState(state);
      if (state === 'open') this.#resolveOpen();
      if (state === 'failed' || state === 'closed') this.#rejectOpen(new Error('Conexão direta não foi estabelecida.'));
    }
    #newPeer() {
      const pc = new this.RTC({ iceServers: this.iceServers });
      this.pc = pc;
      pc.addEventListener('connectionstatechange', () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'failed') { this.#teardown(new Error('Conexão direta falhou.')); this.#setState('failed'); }
        else if (pc.connectionState === 'closed') this.close();
      });
      return pc;
    }
    #bindChannel(channel) {
      this.channel = channel;
      channel.addEventListener('open', () => this.#setState('open'));
      channel.addEventListener('close', () => { this.#teardown(new Error('Conexão direta encerrada.')); this.#setState('closed'); });
      channel.addEventListener('message', (event) => this.#onMessage(event.data));
    }

    // ---- Host (quem cria a sala): gera a oferta e depois aceita a resposta ----
    async createOffer(extra) {
      if (this.pc) throw new Error('Conexão já iniciada.');
      const pc = this.#newPeer();
      this.#bindChannel(pc.createDataChannel('duotela', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      const sdp = pc.localDescription?.sdp;
      if (!sdp || !/a=candidate/.test(sdp)) throw new Error('Não foi possível reunir dados de rede para a conexão.');
      this.#setState('waiting');
      return encodeAuto('offer', sdp, extra);
    }
    async acceptAnswer(code) {
      const { type, sdp, extra } = decodeCode(code);
      if (type !== 'answer' || !this.pc || this.pc.signalingState !== 'have-local-offer') throw new Error('Esta resposta não corresponde ao convite gerado neste aparelho.');
      this.#setState('connecting');
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      return { extra };
    }

    // ---- Convidado: aceita a oferta e devolve a resposta ----
    /** answerExtra: dados que vão na resposta (ex.: { room } quando o Host responde a quem ofereceu). */
    async acceptOffer(code, answerExtra) {
      if (this.pc) throw new Error('Conexão já iniciada.');
      const { type, sdp, extra } = decodeCode(code);
      if (type !== 'offer') throw new Error('Este código é uma resposta, não um convite.');
      const pc = this.#newPeer();
      pc.addEventListener('datachannel', (event) => this.#bindChannel(event.channel));
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIce(pc);
      const answer = pc.localDescription?.sdp;
      if (!answer || !/a=candidate/.test(answer)) throw new Error('Não foi possível reunir dados de rede para a conexão.');
      this.#setState('connecting');
      return { answer: encodeAuto('answer', answer, answerExtra), extra };
    }

    close() {
      this.#teardown(new Error('Conexão direta encerrada.'));
      try { this.channel?.close(); } catch { /* já fechado */ }
      try { this.pc?.close(); } catch { /* já fechado */ }
      this.#setState('closed');
    }
    #teardown(error) {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
      for (const r of this.inflight.values()) r.abort?.abort();
      this.inflight.clear();
    }

    #send(kind, id, payload) {
      const text = JSON.stringify(payload);
      const total = Math.max(1, Math.ceil(text.length / CHUNK));
      for (let i = 0; i < total; i++) this.channel.send(JSON.stringify({ k: kind, id, n: i, last: i === total - 1, d: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
    }
    #onMessage(data) {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m.id !== 'number' || typeof m.d !== 'string' && m.k !== 'x') return;
      if (m.k === 'x') { this.inflight.get(m.id)?.abort?.abort(); this.inflight.delete(m.id); return; }
      const table = m.k === 'q' ? this.inflight : m.k === 'r' ? this.pending : null;
      if (!table) return;
      let entry = table.get(m.id);
      if (m.k === 'q' && !entry) {
        if (!this.handler) return;
        if (this.inflight.size >= MAX_INFLIGHT) { this.#send('r', m.id, { status: 429, body: '{"ok":false,"error":"too_many_requests"}' }); return; }
        entry = { parts: [], size: 0, abort: new AbortController() };
        this.inflight.set(m.id, entry);
      }
      if (!entry) return;
      entry.parts.push(m.d); entry.size = (entry.size || 0) + m.d.length;
      if (entry.size > (m.k === 'q' ? MAX_BODY * 2 : MAX_RESPONSE * 2)) { this.#fail(m.k, m.id, entry); return; }
      if (!m.last) return;
      let payload;
      try { payload = JSON.parse(entry.parts.join('')); } catch { this.#fail(m.k, m.id, entry); return; }
      if (m.k === 'q') void this.#serve(m.id, entry, payload);
      else {
        clearTimeout(entry.timer); this.pending.delete(m.id);
        if (typeof payload.status !== 'number' || typeof payload.body !== 'string') return entry.reject(new Error('Resposta inválida do Host.'));
        entry.resolve(typeof Response === 'function' ? new Response(payload.body, { status: payload.status, headers: { 'Content-Type': 'application/json' } })
          : { ok: payload.status >= 200 && payload.status < 300, status: payload.status, json: async () => JSON.parse(payload.body) });
      }
    }
    #fail(kind, id, entry) {
      if (kind === 'q') { this.inflight.delete(id); this.#send('r', id, { status: 413, body: '{"ok":false,"error":"too_large"}' }); }
      else { clearTimeout(entry.timer); this.pending.delete(id); entry.reject(new Error('Resposta grande demais.')); }
    }

    // ---- Host: atende as requisições do convidado ----
    /** handler({method, path, headers, body, signal}) -> {status, body}. Só rotas permitidas chegam ao handler. */
    serve(handler) { this.handler = handler; }
    async #serve(id, entry, req) {
      const reply = (status, body) => { if (this.inflight.get(id) === entry && this.channel?.readyState === 'open') this.#send('r', id, { status, body }); this.inflight.delete(id); };
      const ok = req && typeof req.method === 'string' && typeof req.path === 'string' && isAllowedGuestRoute(req.method, req.path) &&
        (req.body === undefined || (typeof req.body === 'string' && req.body.length <= MAX_BODY));
      if (!ok) { this.stats.rejected++; return reply(403, '{"ok":false,"error":"route_not_allowed"}'); }
      const headers = {};
      const h = req.headers || {};
      if (typeof h.authorization === 'string' && h.authorization.length < 100) headers.authorization = h.authorization;
      if (typeof h['content-type'] === 'string' && h['content-type'].length < 100) headers['content-type'] = h['content-type'];
      try {
        const out = await this.handler({ method: req.method, path: req.path, headers, body: req.body, signal: entry.abort.signal });
        if (typeof out?.body !== 'string' || out.body.length > MAX_RESPONSE) return reply(502, '{"ok":false,"error":"bad_gateway"}');
        this.stats.served++;
        reply(Number(out.status) || 502, out.body);
      } catch { reply(502, '{"ok":false,"error":"bad_gateway"}'); }
    }
    /** Handler padrão do Host: repassa ao serviço local (mesma origem da interface). */
    static localHandler(fetchImpl, baseOrigin) {
      return async ({ method, path, headers, body, signal }) => {
        const res = await fetchImpl(baseOrigin + path, { method, headers, body, signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
        return { status: res.status, body: await res.text() };
      };
    }

    // ---- Convidado: fetch que atravessa o canal ----
    /** Compatível com a opção fetchImpl do DuoRoomClient. */
    fetch = (url, init = {}) => {
      const t0 = Date.now(), poll = /\/state\?/.test(String(url)), st = this.stats;
      st.sent++;
      return this.#fetchRaw(url, init).then((res) => {
        if (!poll) { st.lastMs = Date.now() - t0; st.timed++; st.avgMs += (st.lastMs - st.avgMs) / st.timed; }   // o long poll espera de propósito: fica fora da média
        return res;
      }, (e) => { if (e?.name !== 'AbortError') st.failed++; throw e; });
    };
    #fetchRaw = (url, init = {}) => {
      if (this.state !== 'open' || this.channel?.readyState !== 'open') return Promise.reject(new Error('Conexão direta com o Host não está aberta.'));
      let u;
      try { u = new URL(url); } catch { return Promise.reject(new Error('Endereço inválido.')); }
      const headers = {};
      for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        const signal = init.signal;
        const abort = () => {
          const p = this.pending.get(id); if (!p) return;
          clearTimeout(p.timer); this.pending.delete(id);
          try { this.channel.send(JSON.stringify({ k: 'x', id })); } catch { /* canal caiu */ }
          reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('O Host não respondeu a tempo.')); }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer, parts: [], size: 0 });
        signal?.addEventListener('abort', abort, { once: true });
        try { this.#send('q', id, { method: init.method || 'GET', path: u.pathname + u.search, headers, body: init.body }); }
        catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
      });
    };
  }

  return { P2PLink, encodeCode, decodeCode, encodeCompact, looksLikeCode, isAllowedGuestRoute, PREFIX, PREFIX2 };
});
