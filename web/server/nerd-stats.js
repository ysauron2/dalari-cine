/* Estatísticas "para nerds": coleta tudo o que o aplicativo sabe sobre si mesmo, a sala, a conexão direta e a voz,
   e formata como texto. Só lê estado que já existe; não envia nada a lugar nenhum. O relatório NUNCA inclui credenciais,
   convites, SDP nem endereços IP: só tipos de rota, contadores e estados. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoNerdStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const f1 = (v, unit = '') => (num(v) === null ? '—' : v.toFixed(1) + unit);
  const f0 = (v, unit = '') => (num(v) === null ? '—' : Math.round(v) + unit);
  const bytes = (v) => { if (num(v) === null) return '—'; if (v < 1024) return v + ' B'; if (v < 1048576) return (v / 1024).toFixed(1) + ' KB'; return (v / 1048576).toFixed(2) + ' MB'; };
  const yes = (v) => (v === undefined || v === null ? '—' : v ? 'sim' : 'não');

  /** Resume um RTCPeerConnection: estados, rota escolhida, RTT, taxas brutas de áudio e do canal de dados. */
  async function rtcSummary(pc) {
    const out = { conn: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, gathering: pc.iceGatheringState };
    let stats;
    try { stats = await pc.getStats(); } catch { return out; }
    const byId = new Map();
    stats.forEach((r) => byId.set(r.id, r));
    let transport = null, pair = null;
    stats.forEach((r) => { if (r.type === 'transport') transport = r; });
    if (transport?.selectedCandidatePairId) pair = byId.get(transport.selectedCandidatePairId);
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r; });
    if (pair) {
      const l = byId.get(pair.localCandidateId), r = byId.get(pair.remoteCandidateId);
      out.route = { local: l?.candidateType, remote: r?.candidateType, protocol: l?.protocol, network: l?.networkType, relayProtocol: l?.relayProtocol,
        rttMs: num(pair.currentRoundTripTime) === null ? null : pair.currentRoundTripTime * 1000, availableOutKbps: num(pair.availableOutgoingBitrate) === null ? null : pair.availableOutgoingBitrate / 1000,
        bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived, requestsSent: pair.requestsSent, responsesReceived: pair.responsesReceived };
    }
    if (transport) out.transport = { dtls: transport.dtlsState, cipher: transport.dtlsCipher, srtp: transport.srtpCipher, ice: transport.iceState };
    stats.forEach((r) => {
      const audio = r.kind === 'audio' || r.mediaType === 'audio';
      if (r.type === 'inbound-rtp' && audio) {
        const codec = byId.get(r.codecId);
        out.inbound = { packets: r.packetsReceived, lost: r.packetsLost, jitterMs: num(r.jitter) === null ? null : r.jitter * 1000, bytes: r.bytesReceived, level: r.audioLevel,
          concealedRatio: r.totalSamplesReceived ? (r.concealedSamples || 0) / r.totalSamplesReceived : null,
          jitterBufferMs: r.jitterBufferEmittedCount ? (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000 : null,
          codec: codec ? `${(codec.mimeType || '').replace('audio/', '')} ${codec.clockRate || ''}Hz ${codec.channels || ''}ch` : null, fmtp: codec?.sdpFmtpLine };
      }
      if (r.type === 'outbound-rtp' && audio) out.outbound = { packets: r.packetsSent, bytes: r.bytesSent, targetKbps: num(r.targetBitrate) === null ? null : r.targetBitrate / 1000 };
      if (r.type === 'remote-inbound-rtp' && audio) out.remote = { rttMs: num(r.roundTripTime) === null ? null : r.roundTripTime * 1000, lossFraction: r.fractionLost, jitterMs: num(r.jitter) === null ? null : r.jitter * 1000 };
      if (r.type === 'data-channel') out.channel = { state: r.state, messagesSent: r.messagesSent, messagesReceived: r.messagesReceived, bytesSent: r.bytesSent, bytesReceived: r.bytesReceived };
    });
    return out;
  }

  class NerdStats {
    /** getContext() devolve { client, snapshot, voice, hostLinks, guestLink, youtube, desktop, extra }. */
    constructor(getContext, { now = () => Date.now(), env = typeof window !== 'undefined' ? window : {} } = {}) {
      this.getContext = getContext; this.now = now; this.env = env;
      this.events = []; this.prev = new Map();
      this.fps = null; this.frames = 0; this.frameT0 = now(); this.rafId = null; this.timer = null;
    }

    /** Registra um evento (rotulado com hora) no histórico mostrado no painel. Mantém os últimos 40. */
    log(message) {
      const d = new Date(this.now());
      this.events.push(`${d.toLocaleTimeString('pt-BR', { hour12: false })} ${String(message).slice(0, 140)}`);
      if (this.events.length > 40) this.events.shift();
    }

    startFps() {
      const env = this.env;
      if (this.rafId !== null || typeof env.requestAnimationFrame !== 'function') return;
      const tick = () => {
        this.frames++;
        const t = this.now();
        if (t - this.frameT0 >= 1000) { this.fps = (this.frames * 1000) / (t - this.frameT0); this.frames = 0; this.frameT0 = t; }
        this.rafId = env.requestAnimationFrame(tick);
      };
      this.rafId = env.requestAnimationFrame(tick);
    }
    stopFps() { if (this.rafId !== null && typeof this.env.cancelAnimationFrame === 'function') this.env.cancelAnimationFrame(this.rafId); this.rafId = null; this.fps = null; }

    rate(key, t, value) {
      const p = this.prev.get(key); this.prev.set(key, { t, value });
      if (!p || num(value) === null || num(p.value) === null || t <= p.t) return null;
      return ((value - p.value) * 8) / (t - p.t);   // kbit/s (bytes * 8 / ms)
    }

    async collect() {
      const ctx = this.getContext() || {};
      const env = this.env, nav = env.navigator || {}, t = this.now();
      const sections = [];

      // ---- aplicativo e navegador ----
      const app = [];
      app.push(['Modo', ctx.desktop ? 'Aplicativo (Electron)' : 'Navegador']);
      const v = ctx.desktop?.versions;
      if (v) app.push(['Versões', `Electron ${v.electron || '?'} · Chromium ${v.chrome || '?'} · Node ${v.node || '?'}`]);
      app.push(['Agente do navegador', String(nav.userAgent || '—').replace(/^Mozilla\/5\.0 /, '').slice(0, 110)]);
      app.push(['Origem segura (microfone/criptografia)', `${yes(env.isSecureContext)} · crypto.subtle ${yes(!!env.crypto?.subtle)}`]);
      const c = nav.connection;
      app.push(['Rede do sistema', `${nav.onLine === false ? 'OFFLINE' : 'online'}${c ? ` · ${c.effectiveType || '?'} · RTT ${f0(c.rtt, ' ms')} · ${f1(c.downlink, ' Mbit/s')}${c.saveData ? ' · economia de dados' : ''}` : ''}`]);
      app.push(['Dispositivo', `${nav.hardwareConcurrency || '?'} CPUs · ${nav.deviceMemory ? nav.deviceMemory + ' GB' : 'memória n/d'} · tela ${env.screen?.width || '?'}×${env.screen?.height || '?'} @${env.devicePixelRatio || 1}x`]);
      app.push(['Idioma / fuso', `${nav.language || '?'} · ${(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return '?'; } })()}`]);
      const mem = env.performance?.memory;
      app.push(['Desempenho', `${this.fps === null ? 'FPS n/d' : f0(this.fps) + ' FPS'}${mem ? ` · memória JS ${bytes(mem.usedJSHeapSize)} / ${bytes(mem.jsHeapSizeLimit)}` : ''}`]);
      sections.push({ title: 'Aplicativo e navegador', rows: app });

      // ---- sala ----
      const s = ctx.snapshot, cl = ctx.client;
      const room = [];
      if (!cl || !s) room.push(['Sala', 'não conectado']);
      else {
        room.push(['Papel / status', `${cl.role} · ${s.status} · conexão ${ctx.extra?.status || '?'}`]);
        room.push(['Revisão do estado / seq', `${s.revision} · seq ${s.yourLastSeq ?? '—'}`]);
        room.push(['Participantes', `${s.participants?.length ?? '?'} de ${s.capacity ?? '?'} · pendentes ${s.pendingGuests?.length || 0} · presença ${Object.entries(s.presence || {}).map(([k, x]) => `${k}:${x ? 'on' : 'off'}`).join(' ') || '—'}`]);
        room.push(['Plataforma / mídia', `${s.platform || '—'} · ${s.media ? (s.media.provider + ' ' + (s.media.videoId || s.media.watchId || '')) : 'nenhuma'}`]);
        room.push(['Rodada', s.round ? `nº ${s.round.roundNumber} · ${s.round.picks?.length || 0} opções${s.round.late?.length ? ' · entrou depois: ' + s.round.late.join(',') : ''}` : '—']);
        const m = cl.metrics;
        if (m) {
          room.push(['Chamadas à sala', `${m.calls} (erros ${m.errors}) · última ${f0(m.lastMs, ' ms')} · média ${f0(m.avgMs, ' ms')} · máx ${f0(m.maxMs, ' ms')}`]);
          room.push(['Long poll de estado', `${m.polls} respostas · última espera ${f1(m.lastPollMs / 1000, ' s')}${m.lastError ? ' · último erro ' + m.lastError : ''}`]);
        }
        const p = s.playback;
        if (p) {
          let drift = '—';
          if (ctx.youtube && s.media?.provider === 'youtube') { const d = ctx.youtube.currentPosition() - ctx.youtube.syncedPosition(); drift = `${d >= 0 ? '+' : ''}${d.toFixed(2)} s (player − sala)`; }
          room.push(['Reprodução', `${p.state} · posição da sala ${f1(ctx.youtube?.syncedPosition?.() ?? p.positionSec, ' s')} · versão ${p.version} · por ${p.updatedBy || '—'}`]);
          room.push(['Deriva do player', drift]);
        }
      }
      sections.push({ title: 'Sala', rows: room });

      // ---- conexão direta ----
      const links = [];
      const addLink = async (name, link) => {
        const sum = await rtcSummary(link.pc);
        const st = link.stats || {};
        links.push([name, `${link.state} · pc ${sum.conn}/ICE ${sum.ice}`]);
        if (sum.route) links.push(['  rota', `${sum.route.local || '?'}→${sum.route.remote || '?'} ${sum.route.protocol || ''}${sum.route.network ? ' (' + sum.route.network + ')' : ''}${sum.route.relayProtocol ? ' relay ' + sum.route.relayProtocol : ''} · RTT ${f0(sum.route.rttMs, ' ms')}`]);
        if (sum.transport) links.push(['  segurança', `DTLS ${sum.transport.dtls || '?'} ${sum.transport.cipher || ''}`.trim()]);
        if (sum.channel) {
          const rx = this.rate(name + ':rx', t, sum.channel.bytesReceived), tx = this.rate(name + ':tx', t, sum.channel.bytesSent);
          links.push(['  canal de dados', `${sum.channel.state} · ↑ ${bytes(sum.channel.bytesSent)} (${f1(tx, ' kbit/s')}) · ↓ ${bytes(sum.channel.bytesReceived)} (${f1(rx, ' kbit/s')}) · msgs ${sum.channel.messagesSent}/${sum.channel.messagesReceived}`]);
        }
        links.push(['  túnel de requisições', `enviadas ${st.sent || 0} (falhas ${st.failed || 0}) · última ${f0(st.lastMs, ' ms')} · média ${f0(st.avgMs, ' ms')} · atendidas pelo Host ${st.served || 0} (recusadas ${st.rejected || 0})`]);
      };
      if (ctx.guestLink?.pc) await addLink('Link com o Host', ctx.guestLink);
      for (const [i, l] of (ctx.hostLinks || []).entries()) if (l.pc) await addLink(`Link com convidado ${i + 1}`, l);
      if (!links.length) links.push(['Conexão direta', 'nenhuma aberta (sala local ou mesmo servidor)']);
      sections.push({ title: 'Conexão direta (WebRTC)', rows: links });

      // ---- voz ----
      const voice = ctx.voice, vr = [];
      if (!voice) vr.push(['Voz', 'indisponível']);
      else {
        vr.push(['Estado', `${voice.state} · ${voice.joined ? (voice.muted ? 'ligada, microfone mudo' : 'ligada') : 'desligada'} · volume ${f0(voice.volume * 100, '%')} · tentativas automáticas ${voice.autoRetries || 0}`]);
        const track = voice.stream?.getAudioTracks?.()[0];
        if (track) {
          const st = track.getSettings?.() || {};
          vr.push(['Microfone', `${track.label || 'sem nome'} · ${st.sampleRate ? st.sampleRate + ' Hz' : '? Hz'} · ${st.channelCount || '?'} canal(is) · eco ${yes(st.echoCancellation)} · ruído ${yes(st.noiseSuppression)} · ganho auto ${yes(st.autoGainControl)} · ${track.readyState}${track.muted ? ' · MUDO no sistema' : ''}`]);
        }
        vr.push(['Dispositivos escolhidos', `entrada ${voice.inputId ? 'personalizada' : 'padrão'} · saída ${voice.outputId ? 'personalizada' : 'padrão'} · troca de saída ${yes(voice.canSelectOutput)}`]);
        for (const [id, p] of voice.peers || []) {
          if (!p.pc) { vr.push([`Com ${id}`, `${p.state} · sem conexão`]); continue; }
          const sum = await rtcSummary(p.pc);
          vr.push([`Com ${id}`, `${p.state} · pc ${sum.conn}/ICE ${sum.ice} · sessão ${p.session ?? '—'}${p.initiator ? ' · ofereceu' : ' · respondeu'}`]);
          if (sum.route) vr.push(['  rota', `${sum.route.local || '?'}→${sum.route.remote || '?'} ${sum.route.protocol || ''}${sum.route.network ? ' (' + sum.route.network + ')' : ''} · RTT ${f0(sum.route.rttMs, ' ms')} · banda estimada ↑ ${f0(sum.route.availableOutKbps, ' kbit/s')}`]);
          if (sum.transport) vr.push(['  segurança', `DTLS ${sum.transport.dtls || '?'} · SRTP ${sum.transport.srtp || '?'}`]);
          if (sum.inbound) {
            const i = sum.inbound, total = (i.packets || 0) + (i.lost || 0), kbps = this.rate(id + ':in', t, i.bytes);
            vr.push(['  recebendo', `${i.codec || 'codec ?'} · ${f1(kbps, ' kbit/s')} · perda ${total ? f1(((i.lost || 0) * 100) / total, '%') : '—'} (${i.lost || 0}/${total}) · jitter ${f1(i.jitterMs, ' ms')} · buffer ${f0(i.jitterBufferMs, ' ms')} · mascarado ${i.concealedRatio === null ? '—' : f1(i.concealedRatio * 100, '%')} · nível ${i.level === undefined ? '—' : f1(i.level * 100, '%')}`]);
            if (i.fmtp) vr.push(['  formato', i.fmtp]);
          }
          if (sum.outbound) { const kbps = this.rate(id + ':out', t, sum.outbound.bytes); vr.push(['  enviando', `${f1(kbps, ' kbit/s')} · ${sum.outbound.packets || 0} pacotes · meta ${f0(sum.outbound.targetKbps, ' kbit/s')}`]); }
          if (sum.remote) vr.push(['  visto pelo outro lado', `RTT ${f0(sum.remote.rttMs, ' ms')} · perda ${f1((sum.remote.lossFraction || 0) * 100, '%')} · jitter ${f1(sum.remote.jitterMs, ' ms')}`]);
        }
      }
      sections.push({ title: 'Voz', rows: vr });

      if (this.events.length) sections.push({ title: 'Eventos recentes', rows: this.events.slice(-25).map((e) => ['', e]) });
      return sections;
    }

    static toText(sections) {
      return sections.map((sec) => `== ${sec.title} ==\n` + sec.rows.map(([k, v]) => (k ? `${k}: ${v}` : v)).join('\n')).join('\n\n');
    }
  }

  return { NerdStats, rtcSummary };
});
