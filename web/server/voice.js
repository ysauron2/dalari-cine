/* Chamada de voz experimental para até quatro participantes aprovados, em malha (cada par tem
   sua própria conexão WebRTC). O serviço da sala só transporta o SDP de cada par, e só para as duas
   pontas; o áudio vai direto entre os navegadores. Sem TURN configurado, algumas redes não conectarão. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoVoice = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Espera os candidatos de rede, mas sem exigir que a coleta TERMINE: com várias placas de rede (VMware, VPN, WSL) o
  // navegador aguarda o tempo limite do STUN de cada uma e a coleta pode passar de 15 s. Passado o prazo curto,
  // segue com o que já foi coletado (desde que haja ao menos um candidato); o limite duro continua sendo 15 s.
  const ICE = { softMs: 3500, hardMs: 15000 };
  const PREF_KEY = 'duotela-audio-devices';
  const loadPrefs = () => { try { const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); return { input: typeof p.input === 'string' ? p.input : '', output: typeof p.output === 'string' ? p.output : '' }; } catch { return { input: '', output: '' }; } };
  const savePrefs = (input, output) => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ input, output })); } catch { /* sem armazenamento */ } };
  const BASE_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  // Quem está falando: nível de áudio (0..1) lido do getStats; liga acima de "on", desliga abaixo de "off" depois de "holdMs".
  const SPEECH = { on: 0.02, off: 0.01, holdMs: 500, pollMs: 150 };
  const PTT_KEY = 'duotela-ptt';
  const loadPtt = () => { try { const p = JSON.parse(localStorage.getItem(PTT_KEY) || '{}'); return { on: p.on === true, code: typeof p.code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(p.code) ? p.code : 'Backquote' }; } catch { return { on: false, code: 'Backquote' }; } };
  const savePtt = (ptt) => { try { localStorage.setItem(PTT_KEY, JSON.stringify(ptt)); } catch { /* sem armazenamento */ } };
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const hasCandidate = (pc) => /a=candidate:/.test(pc.localDescription?.sdp || '');
  function waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const hard = setTimeout(() => finish(new Error('O navegador não concluiu a conexão de voz. Tente novamente.')), ICE.hardMs);
      const soft = setTimeout(() => { if (hasCandidate(pc)) finish(); }, ICE.softMs);
      function finish(error) {
        clearTimeout(hard); clearTimeout(soft);
        pc.removeEventListener('icegatheringstatechange', changed);
        pc.removeEventListener('signalingstatechange', changed);
        if (error) reject(error); else resolve();
      }
      function changed() {
        if (pc.signalingState === 'closed') finish(new Error('Chamada encerrada.'));
        else if (pc.iceGatheringState === 'complete') finish();
      }
      pc.addEventListener('icegatheringstatechange', changed);
      pc.addEventListener('signalingstatechange', changed);
      changed();
    });
  }

  class VoiceCall {
    constructor({ onChange, mount, onSpeaking, onLevels } = {}) {
      const prefs = loadPrefs();
      this.onSpeaking = onSpeaking || (() => {});
      this.onLevels = onLevels || (() => {});     // volume de cada pessoa (0..1) a cada medição, para o avatar "respirar"
      this.peerVolumes = new Map();                         // id -> 0..1 (só nesta sessão)
      this.ptt = loadPtt(); this.pttHeld = false;           // falar apertando uma tecla
      this.speaking = {}; this.lastLoud = {}; this.speechTimer = null; this.polling = false;
      this.inputId = prefs.input; this.outputId = prefs.output;    // '' = padrão do sistema
      this.onChange = onChange || (() => {});
      this.mount = mount || null;       // onde anexar os elementos de áudio extras (pessoas 3 e 4)
      this.client = null;
      this.stream = null;
      this.snapshot = null;
      this.peers = new Map();           // id do participante -> estado da ligação com ele
      this.state = 'off';
      this.muted = false;
      this.volume = 1;
      this.audio = this.makeAudio();    // áudio da primeira ligação (compatível com a versão para dupla)
      this.autoRetries = 0; this.retryTimer = null; this.stableTimer = null;
      this.spareAudio = [];
    }

    makeAudio() {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.volume = this.volume;
      audio.setAttribute('aria-hidden', 'true');
      if (this.outputId && typeof audio.setSinkId === 'function') audio.setSinkId(this.outputId).catch(() => {});
      return audio;
    }

    attach(client) { this.client = client; }
    get joined() { return !!this.stream; }
    /** Primeira conexão aberta (a única, numa dupla). */
    get peer() { for (const p of this.peers.values()) if (p.pc) return p.pc; return null; }
    emit(state) { if (this.state !== state) { this.state = state; this.onChange(state); } }

    /** Estado por pessoa, para a interface mostrar quem já está na conversa. */
    peerStates() {
      const out = {};
      for (const [id, p] of this.peers) out[id] = p.state;
      return out;
    }

    idOf(entry) { for (const [id, p] of this.peers) if (p === entry) return id; return null; }
    effectiveVolume(id) { return clamp01(this.volume * (this.peerVolumes.has(id) ? this.peerVolumes.get(id) : 1)); }

    audioFor(entry) {
      if (entry.audio) return entry.audio;
      const used = new Set([...this.peers.values()].map((p) => p.audio));
      let el = [this.audio, ...this.spareAudio].find((a) => !used.has(a));
      if (!el) {
        el = this.makeAudio();
        this.spareAudio.push(el);
        if (this.mount) this.mount.append(el);
      }
      entry.audio = el;
      el.volume = this.effectiveVolume(this.idOf(entry));
      return el;
    }

    resetPeer(id) {
      const p = this.peers.get(id);
      if (!p) return;
      p.serial += 1;
      if (p.pc) { p.pc.close(); p.pc = null; }
      if (p.audio) p.audio.srcObject = null;
      p.handledAnswer = null;
      p.pending = false;
      p.state = 'waiting';
    }

    dropPeer(id) {
      this.resetPeer(id);
      const p = this.peers.get(id);
      if (p && p.audio) p.audio = null;
      this.peers.delete(id);
    }

    closeLocal() {
      for (const id of [...this.peers.keys()]) this.dropPeer(id);
      if (this.stream) { for (const track of this.stream.getTracks()) track.stop(); this.stream = null; }
      this.snapshot = null;
      this.muted = false;
      clearTimeout(this.retryTimer); clearTimeout(this.stableTimer); this.autoRetries = 0;
      this.stopSpeechMonitor(); this.pttHeld = false;
      this.emit('off');
    }

    async join() {
      if (this.joined) return;
      const client = this.client;
      if (!client || client.snapshot?.status !== 'active') throw new Error('Entre na sala antes de ligar a voz.');
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        // Fora de localhost/127.0.0.1/https o navegador esconde o microfone (navigator.mediaDevices fica indefinido).
        const insecure = typeof isSecureContext !== 'undefined' && isSecureContext === false;
        const insecureErr = new Error(insecure
          ? 'O navegador só libera o microfone em páginas seguras (https, localhost ou 127.0.0.1). Esta página usa um endereço http da rede local. Abra o Dalari Cine por http://127.0.0.1:PORTA no computador onde ele roda ou use a conexão direta.'
          : 'Este navegador não oferece chamada de voz aqui.');
        insecureErr.code = insecure ? 'mic_insecure' : 'mic_missing';
        throw insecureErr;
      }
      this.emit('permission');
      let stream;
      try { stream = await this.acquire(); }
      catch (e) {
        this.emit('off');
        const why = {
          NotAllowedError: 'O microfone está bloqueado. Clique no cadeado ao lado do endereço, permita o Microfone e tente de novo (no Mac, confira também Ajustes do Sistema > Privacidade e Segurança > Microfone).',
          NotFoundError: 'Nenhum microfone foi encontrado. Conecte um e tente de novo.',
          NotReadableError: 'Não foi possível usar o microfone: outro aplicativo pode estar usando-o.',
        }[e?.name];
        const err = new Error(why || 'Permita o microfone no navegador para ligar a voz.');
        err.code = { NotAllowedError: 'mic_denied', NotFoundError: 'mic_missing', NotReadableError: 'mic_busy' }[e?.name] || 'mic_denied';
        throw err;
      }
      if (client !== this.client || client.snapshot?.status !== 'active') {
        stream.getTracks().forEach((track) => track.stop());
        this.emit('off');
        return;
      }
      this.stream = stream;
      this.applyMic();               // respeita push-to-talk (começa calado até apertar a tecla)
      this.startSpeechMonitor();
      this.emit('waiting');
      // Servidores STUN/TURN da sala; sem eles (ou se a consulta falhar) a conexão só usa candidatos locais.
      try { this.iceServers = typeof client.iceServers === 'function' ? await client.iceServers() : []; }
      catch { this.iceServers = []; }
      try {
        await client.voiceReady(true);
        this.update(client.snapshot);
      } catch (e) { this.closeLocal(); throw e; }
    }

    /** Abre o microfone escolhido (ou o padrão). Se o escolhido não existir mais, esquece-o e usa o padrão. */
    async acquire() {
      const audio = this.inputId ? { ...BASE_AUDIO, deviceId: { exact: this.inputId } } : BASE_AUDIO;
      try { return await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
      catch (e) {
        if (this.inputId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
          this.inputId = ''; savePrefs(this.inputId, this.outputId);
          return navigator.mediaDevices.getUserMedia({ audio: BASE_AUDIO, video: false });
        }
        throw e;
      }
    }

    get canSelectOutput() { return typeof this.audio.setSinkId === 'function'; }

    /** Microfones e saídas de áudio do aparelho. Os nomes só aparecem depois de o microfone ter sido liberado. */
    async listDevices() {
      let all = [];
      try { all = await navigator.mediaDevices?.enumerateDevices?.() || []; } catch { /* sem lista */ }
      const pick = (kind, fallback) => all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
      return { inputs: pick('audioinput', 'Microfone'), outputs: pick('audiooutput', 'Saída de áudio'), canSelectOutput: this.canSelectOutput, labeled: all.some((d) => d.label) };
    }

    /** Troca o microfone durante a conversa, sem desligar a voz: a faixa nova substitui a antiga em todas as ligações. */
    async setInput(deviceId) {
      const previous = this.inputId;
      this.inputId = deviceId || '';
      if (!this.stream) { savePrefs(this.inputId, this.outputId); return; }
      let fresh;
      try { fresh = await this.acquire(); }
      catch (e) { this.inputId = previous; throw new Error('Não foi possível usar este microfone.'); }
      const track = fresh.getAudioTracks()[0];
      track.enabled = this.micOn();
      for (const p of this.peers.values()) for (const sender of p.pc?.getSenders?.() || []) if (sender.track?.kind === 'audio' || !sender.track) await sender.replaceTrack(track);
      const old = this.stream; this.stream = fresh;
      for (const t of old.getTracks()) t.stop();
      savePrefs(this.inputId, this.outputId);
      this.onChange(this.state);
    }

    /** Troca a saída de áudio (onde o navegador permite). '' volta ao padrão do sistema. */
    async setOutput(deviceId) {
      if (!this.canSelectOutput) throw new Error('Este navegador usa a saída de áudio padrão do sistema.');
      const previous = this.outputId;
      this.outputId = deviceId || '';
      try { for (const a of [this.audio, ...this.spareAudio]) await a.setSinkId(this.outputId); }
      catch (e) { this.outputId = previous; for (const a of [this.audio, ...this.spareAudio]) a.setSinkId(previous).catch(() => {}); throw new Error('Não foi possível usar esta saída de áudio.'); }
      savePrefs(this.inputId, this.outputId);
      this.onChange(this.state);
    }

    async leave() {
      const client = this.client;
      const shouldNotify = this.joined && client?.snapshot?.status === 'active';
      this.closeLocal();
      if (shouldNotify) await client.voiceReady(false);
    }

    async retry() {
      if (!this.joined || !this.client) return;
      for (const id of [...this.peers.keys()]) { this.resetPeer(id); this.peers.get(id).failedSession = null; }
      this.emit('connecting');
      try { await this.client.voiceRetry(); this.update(this.client.snapshot); }
      catch (e) { for (const p of this.peers.values()) p.failedSession = p.session; this.emit('failed'); throw e; }
    }

    toggleMute() {
      if (!this.stream) return false;
      this.muted = !this.muted;
      this.applyMic();
      return this.muted;
    }

    /** Volume geral da conversa; o volume de cada pessoa multiplica este. */
    setVolume(value) {
      this.volume = clamp01(value);
      const used = new Set();
      for (const [id, p] of this.peers) if (p.audio) { used.add(p.audio); p.audio.volume = this.effectiveVolume(id); }
      for (const a of [this.audio, ...this.spareAudio]) if (!used.has(a)) a.volume = this.volume;
    }
    setPeerVolume(id, value) {
      this.peerVolumes.set(id, clamp01(value));
      const p = this.peers.get(id);
      if (p?.audio) p.audio.volume = this.effectiveVolume(id);
      this.onChange(this.state);
    }

    // ---- microfone: mudo e "falar apertando uma tecla" ----
    micOn() { return !this.muted && (!this.ptt.on || this.pttHeld); }
    applyMic() {
      if (!this.stream) return;
      const on = this.micOn();
      for (const t of this.stream.getAudioTracks()) t.enabled = on;
      this.onChange(this.state);
    }
    /** Liga/desliga o modo push-to-talk; code é a tecla (KeyboardEvent.code). */
    setPtt(on, code) {
      this.ptt = { on: !!on, code: typeof code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(code) ? code : this.ptt.code };
      this.pttHeld = false;
      savePtt(this.ptt);
      this.applyMic();
    }
    pttPress(down) {
      if (!this.ptt.on || this.pttHeld === !!down) return;
      this.pttHeld = !!down;
      this.applyMic();
    }

    // ---- quem está falando ----
    startSpeechMonitor() {
      if (this.speechTimer) return;
      this.speechTimer = setInterval(() => { void this.pollSpeech(); }, SPEECH.pollMs);
    }
    stopSpeechMonitor() {
      clearInterval(this.speechTimer); this.speechTimer = null;
      this.onLevels({});
      if (Object.keys(this.speaking).length) { this.speaking = {}; this.lastLoud = {}; this.onSpeaking({}); }
    }
    async pollSpeech(now = Date.now()) {
      if (this.polling || !this.joined) return;
      this.polling = true;
      try {
        const levels = {};
        for (const [id, p] of this.peers) {
          if (!p.pc?.getStats || p.pc.connectionState === 'closed') continue;
          const stats = await p.pc.getStats();
          stats.forEach((r) => {
            if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio') && typeof r.audioLevel === 'number') levels[id] = r.audioLevel;
            if (r.type === 'media-source' && (r.kind === 'audio') && typeof r.audioLevel === 'number') levels.local = Math.max(levels.local || 0, r.audioLevel);
          });
        }
        if (!this.micOn()) levels.local = 0;                          // mudo ou push-to-talk solto: não aparece como falando
        this.onLevels({ ...levels });
        const next = { ...this.speaking };
        for (const [id, level] of Object.entries(levels)) {
          if (level >= SPEECH.on) { this.lastLoud[id] = now; next[id] = true; }
          else if (next[id] && level < SPEECH.off && now - (this.lastLoud[id] || 0) > SPEECH.holdMs) next[id] = false;
        }
        for (const id of Object.keys(next)) if (id !== 'local' && !this.peers.has(id)) delete next[id];
        const key = (o) => JSON.stringify(Object.keys(o).filter((k) => o[k]).sort());
        if (key(next) !== key(this.speaking)) { this.speaking = next; this.onSpeaking({ ...next }); } else this.speaking = next;
      } catch { /* sem estatísticas: segue sem indicador */ } finally { this.polling = false; }
    }

    newPeer(id) {
      this.resetPeer(id);
      const entry = this.peers.get(id);
      const pc = new RTCPeerConnection({ iceServers: this.iceServers || [] });
      entry.pc = pc;
      for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
      pc.addEventListener('track', (event) => {
        if (pc !== entry.pc) return;
        const audio = this.audioFor(entry);
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        const playing = audio.play();
        if (playing?.catch) playing.catch(() => this.setPeerState(id, 'audio_blocked'));
      });
      pc.addEventListener('connectionstatechange', () => {
        if (pc !== entry.pc) return;
        if (pc.connectionState === 'connected') {
          this.setPeerState(id, 'connected');
          clearTimeout(this.stableTimer); this.stableTimer = setTimeout(() => { this.autoRetries = 0; }, 15000);   // só zera depois de ficar estável
        } else if (pc.connectionState === 'failed') {
          entry.failedSession = entry.session; clearTimeout(this.stableTimer); this.setPeerState(id, 'failed'); this.autoRetry(entry);
        }
        else if (pc.connectionState === 'disconnected') this.setPeerState(id, 'reconnecting');
        else if (pc.connectionState === 'connecting') this.setPeerState(id, 'connecting');
      });
      return pc;
    }

    /** Falha de ICE: quem oferece (um só lado, para não duplicar) tenta de novo até 3 vezes, com espera crescente. */
    autoRetry(entry) {
      if (!entry.initiator || !this.joined || this.autoRetries >= 3) return;
      this.autoRetries += 1;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => { if (this.joined) this.retry().catch(() => {}); }, 1500 * this.autoRetries);
    }

    /** Texto curto de diagnóstico por ligação: estado do pc e a rota escolhida (tipo dos candidatos). Não inclui IPs. */
    async diagnostics() {
      const parts = [];
      for (const [id, p] of this.peers) {
        const pc = p.pc;
        if (!pc) { parts.push(`${id}: sem conexão`); continue; }
        let route = 'sem rota';
        try {
          const stats = await pc.getStats();
          let pair = null;
          stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
          if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r; });
          if (pair) {
            const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
            route = `${l?.candidateType || '?'}→${r?.candidateType || '?'} ${l?.protocol || ''}`.trim();
          }
        } catch { /* sem estatísticas */ }
        parts.push(`${id}: ${pc.connectionState}/ICE ${pc.iceConnectionState}, rota ${route}`);
      }
      return parts.join(' | ');
    }

    setPeerState(id, state) {
      const p = this.peers.get(id);
      if (p) p.state = state;
      this.refreshState();
    }

    /** Estado geral a partir das ligações: falha em qualquer uma é visível, mas não derruba as outras. */
    refreshState() {
      if (!this.joined) return;
      const list = [...this.peers.values()];
      if (!list.length) { this.emit('waiting'); return; }
      const has = (s) => list.some((p) => p.state === s);
      if (has('failed')) this.emit('failed');
      else if (has('audio_blocked')) this.emit('audio_blocked');
      else if (has('reconnecting')) this.emit('reconnecting');
      else if (list.every((p) => p.state === 'connected')) this.emit('connected');
      else if (has('connected') && list.some((p) => p.state === 'waiting')) this.emit('connected');
      else if (list.every((p) => p.state === 'waiting')) this.emit('waiting');
      else this.emit('connecting');
    }

    async offer(id, session) {
      const entry = this.peers.get(id);
      entry.pending = true;
      try {
        const pc = this.newPeer(id);
        entry.pending = true;
        const serial = entry.serial;
        await pc.setLocalDescription(await pc.createOffer());
        await waitForIce(pc);
        if (serial !== entry.serial || !this.joined || session !== entry.session) return;
        const sdp = pc.localDescription?.sdp;
        if (!sdp || sdp.length > 24000) throw new Error('Dados de voz grandes demais para esta sala.');
        await this.client.voiceOffer(session, sdp, id);
        if (this.peers.get(id)?.state !== 'connected') this.setPeerState(id, 'connecting');
        this.update(this.client.snapshot);
      } catch (e) { if (session === entry.session && this.joined && this.peers.get(id) === entry) { entry.failedSession = session; this.setPeerState(id, 'failed'); } }
      finally { entry.pending = false; }
    }

    async answer(id, session, sdp) {
      const entry = this.peers.get(id);
      entry.pending = true;
      try {
        const pc = this.newPeer(id);
        entry.pending = true;
        const serial = entry.serial;
        await pc.setRemoteDescription({ type: 'offer', sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await waitForIce(pc);
        if (serial !== entry.serial || !this.joined || session !== entry.session) return;
        const reply = pc.localDescription?.sdp;
        if (!reply || reply.length > 24000) throw new Error('Dados de voz grandes demais para esta sala.');
        await this.client.voiceAnswer(session, reply, id);
        if (this.peers.get(id)?.state !== 'connected') this.setPeerState(id, 'connecting');   // a conexão pode abrir antes desta resposta voltar
      } catch (e) { if (session === entry.session && this.joined && this.peers.get(id) === entry) { entry.failedSession = session; this.setPeerState(id, 'failed'); } }
      finally { entry.pending = false; }
    }

    async acceptAnswer(id, session, sdp) {
      const entry = this.peers.get(id);
      entry.handledAnswer = session;
      try {
        if (entry.pc && entry.pc.signalingState === 'have-local-offer') await entry.pc.setRemoteDescription({ type: 'answer', sdp });
      } catch (e) { entry.failedSession = session; this.setPeerState(id, 'failed'); }
    }

    update(snapshot) {
      this.snapshot = snapshot;
      if (!this.joined) return;
      if (!snapshot || snapshot.status !== 'active' || !snapshot.voice) { this.closeLocal(); return; }
      const voice = snapshot.voice;
      const role = this.client?.role;
      if (!role || !voice.ready[role]) return;
      const links = Array.isArray(voice.links) ? voice.links : [];
      const live = new Set(links.map((l) => l.peer));
      for (const id of [...this.peers.keys()]) if (!live.has(id)) this.dropPeer(id);
      for (const link of links) {
        let entry = this.peers.get(link.peer);
        if (!entry) {
          entry = { pc: null, audio: null, session: null, serial: 0, pending: false, failedSession: null, handledAnswer: null, state: 'waiting' };
          this.peers.set(link.peer, entry);
        }
        entry.initiator = !!link.initiator;
        if (link.session !== entry.session) {
          this.resetPeer(link.peer);
          entry.session = link.session;
          entry.failedSession = null;
        }
        if (entry.failedSession === link.session) continue;
        if (link.initiator && !link.hasOffer && !entry.pending && !entry.pc) {
          this.setPeerState(link.peer, 'connecting'); void this.offer(link.peer, link.session);
        } else if (!link.initiator && link.remote?.session === link.session && !link.hasAnswer && !entry.pending && !entry.pc) {
          this.setPeerState(link.peer, 'connecting'); void this.answer(link.peer, link.session, link.remote.sdp);
        } else if (link.initiator && link.remote?.session === link.session && entry.pc && entry.handledAnswer !== link.session) {
          void this.acceptAnswer(link.peer, link.session, link.remote.sdp);
        }
      }
      this.refreshState();
    }
  }

  return { VoiceCall, ICE, waitForIce, SPEECH };
});
