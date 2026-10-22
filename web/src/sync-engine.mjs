/**
 * sync-engine.mjs - motor de sincronizacao puro para uma sessao a dois.
 *
 * Sem DOM, rede ou timers: o chamador fornece o player, o relogio e o envio.
 *
 * Uso:
 *   const engine = createSyncEngine({
 *     selfId: 'ana',                          // id desta origem
 *     content: { title: 'Mar de Inverno', episode: 1 },
 *     player,                                 // ver abaixo
 *     send: (msg) => channel.send(JSON.stringify(msg)),
 *     now: () => Date.now(),                  // opcional (ms)
 *     tolerance: 0.3,        // s; abaixo disso nenhuma acao
 *     seekThreshold: 2,      // s; acima disso seek, entre os dois ajusta playbackRate
 *     rateDelta: 0.05,       // ajuste de velocidade (1 +/- rateDelta)
 *     echoWindowMs: 1000,    // janela para suprimir eventos causados por acao remota
 *   });
 *
 * Player (tempos em segundos):
 *   getCurrentTime(): number
 *   play(): void | Promise      (pode rejeitar com NotAllowedError)
 *   pause(): void
 *   seek(t: number): void
 *   setPlaybackRate?(r: number): void   (opcional; sem ele a deriva so corrige por seek)
 *
 * Mensagens (objetos JSON simples):
 *   { type, seq, from, title, episode, ... }
 *   play/pause/seek/state: + time (s), playing (bool)
 *   ping: + t0 (ms do emissor)      pong: + t0 (eco), tr (ms do respondente)
 *   seq cresce por origem; seq <= ultimo visto e descartado (duplicada/fora de ordem).
 *
 * API:
 *   engine.localPlay() / localPause() / localSeek(time?) / sendState() / ping()
 *       Chame a partir dos eventos do player/UI. Constroem a mensagem, chamam
 *       send(msg) e a retornam; retornam null se o evento for eco de acao remota.
 *   await engine.receive(msgOrJson) -> { status, ... }
 *       status: 'applied' | 'pending' | 'dropped' | 'blocked' | 'invalid' | 'error'
 *       'dropped'  reason: 'duplicate-or-old' | 'self' | 'unknown-peer'
 *       'blocked'  reason: 'content-mismatch' (titulo/episodio diferente)
 *       'pending'  pending: { type:'play', reason:'autoplay-blocked', time }
 *                  (player.play() rejeitou com NotAllowedError; a UI deve mostrar
 *                   um botao e chamar engine.resumePending() num gesto do usuario)
 *   engine.getPending() / await engine.resumePending() / engine.clearPending()
 *   engine.tick() -> { action: 'none'|'rate'|'rate-restored'|'seek', drift, ... }
 *       Chame periodicamente (ex.: 1 Hz) para corrigir deriva. drift = local - remoto (s).
 *   engine.getLatency() -> segundos (rtt minimo / 2 das ultimas medicoes) ou 0
 *   engine.resetPeer()      esquece a outra origem e seq (ex.: par reconectou)
 */

const ACTION_TYPES = new Set(['play', 'pause', 'seek', 'state']);
const ALL_TYPES = new Set([...ACTION_TYPES, 'ping', 'pong']);
const MAX_SAMPLES = 8;

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

export function createSyncEngine(options = {}) {
  const {
    selfId,
    content,
    player,
    send = () => {},
    now = () => Date.now(),
    tolerance = 0.3,
    seekThreshold = 2,
    rateDelta = 0.05,
    echoWindowMs = 1000,
  } = options;

  if (typeof selfId !== 'string' || !selfId) throw new TypeError('selfId obrigatorio');
  if (!content || typeof content.title !== 'string') throw new TypeError('content.title obrigatorio');
  if (!player || typeof player.getCurrentTime !== 'function') throw new TypeError('player invalido');
  if (!(tolerance >= 0) || !(seekThreshold > tolerance)) throw new RangeError('seekThreshold deve ser > tolerance >= 0');
  if (!(rateDelta > 0 && rateDelta < 1)) throw new RangeError('rateDelta deve estar em (0, 1)');

  let seq = 0;
  let peerId = null;
  let lastPeerSeq = -1;
  let playing = false;          // crenca local sobre o estado de reproducao
  let remote = null;            // { time, playing, at }
  let pending = null;
  let rateAdjusted = false;
  const rtts = [];
  const expected = new Map();   // tipo -> expiracao (ms): eventos locais esperados por acao remota

  const getLatency = () => (rtts.length ? Math.min(...rtts) / 2000 : 0);

  function build(type, extra = {}) {
    return { type, seq: seq++, from: selfId, title: content.title, episode: content.episode ?? null, ...extra };
  }

  function emit(msg) {
    send(msg);
    return msg;
  }

  // Executa uma acao no player marcando o evento local resultante como eco.
  function applyToPlayer(type, fn) {
    expected.set(type, now() + echoWindowMs);
    try {
      return fn();
    } catch (err) {
      expected.delete(type);
      throw err;
    }
  }

  function isEcho(type) {
    const until = expected.get(type);
    if (until === undefined) return false;
    expected.delete(type);
    return now() <= until;
  }

  function local(type, extra) {
    if (isEcho(type)) return null;
    return emit(build(type, extra));
  }

  function restoreRate() {
    if (!rateAdjusted) return false;
    rateAdjusted = false;
    if (typeof player.setPlaybackRate === 'function') player.setPlaybackRate(1);
    return true;
  }

  // Posicao remota estimada agora.
  function remoteEstimate() {
    if (!remote) return null;
    if (!remote.playing) return remote.time;
    return remote.time + getLatency() + (now() - remote.at) / 1000;
  }

  async function startPlayback(time) {
    restoreRate();
    if (isNum(time)) applyToPlayer('seek', () => player.seek(time));
    try {
      await applyToPlayer('play', () => player.play());
    } catch (err) {
      expected.delete('play');
      if (err && err.name === 'NotAllowedError') {
        pending = { type: 'play', reason: 'autoplay-blocked', time: player.getCurrentTime() };
        return { status: 'pending', pending: { ...pending } };
      }
      return { status: 'error', error: String(err && err.message ? err.message : err) };
    }
    pending = null;
    playing = true;
    return { status: 'applied' };
  }

  function stopPlayback() {
    pending = null;
    restoreRate();
    if (playing) applyToPlayer('pause', () => player.pause());
    playing = false;
  }

  async function applyAction(msg) {
    const rem = { time: msg.time, playing: msg.playing, at: now() };
    switch (msg.type) {
      case 'play': {
        remote = { ...rem, playing: true };
        return startPlayback(remoteEstimate());
      }
      case 'pause': {
        remote = { ...rem, playing: false };
        stopPlayback();
        applyToPlayer('seek', () => player.seek(msg.time));
        return { status: 'applied' };
      }
      case 'seek': {
        remote = rem;
        restoreRate();
        applyToPlayer('seek', () => player.seek(remoteEstimate()));
        return { status: 'applied' };
      }
      default: { // state
        remote = rem;
        if (rem.playing && !playing && !pending) return startPlayback(remoteEstimate());
        if (!rem.playing && (playing || pending)) {
          stopPlayback();
          applyToPlayer('seek', () => player.seek(rem.time));
          return { status: 'applied' };
        }
        return { status: 'applied', correction: tick() };
      }
    }
  }

  function validate(msg) {
    if (!msg || typeof msg !== 'object' || !ALL_TYPES.has(msg.type)) return false;
    if (typeof msg.from !== 'string' || !msg.from) return false;
    if (!Number.isSafeInteger(msg.seq) || msg.seq < 0) return false;
    if (ACTION_TYPES.has(msg.type)) {
      if (!isNum(msg.time) || msg.time < 0 || typeof msg.playing !== 'boolean') return false;
      if (typeof msg.title !== 'string') return false;
    }
    if (msg.type === 'ping' && !isNum(msg.t0)) return false;
    if (msg.type === 'pong' && (!isNum(msg.t0) || !isNum(msg.tr))) return false;
    return true;
  }

  async function receive(input) {
    let msg = input;
    if (typeof input === 'string') {
      try { msg = JSON.parse(input); } catch { return { status: 'invalid', reason: 'bad-json' }; }
    }
    if (!validate(msg)) return { status: 'invalid', reason: 'bad-message' };
    if (msg.from === selfId) return { status: 'dropped', reason: 'self' };
    if (peerId === null) peerId = msg.from;
    else if (msg.from !== peerId) return { status: 'dropped', reason: 'unknown-peer' };
    if (msg.seq <= lastPeerSeq) return { status: 'dropped', reason: 'duplicate-or-old' };
    lastPeerSeq = msg.seq;

    if (msg.type === 'ping') {
      const reply = emit(build('pong', { t0: msg.t0, tr: now() }));
      return { status: 'applied', reply };
    }
    if (msg.type === 'pong') {
      const rtt = now() - msg.t0;
      if (rtt >= 0) {
        rtts.push(rtt);
        if (rtts.length > MAX_SAMPLES) rtts.shift();
      }
      return { status: 'applied', rtt, latency: getLatency() };
    }
    if (msg.title !== content.title || (msg.episode ?? null) !== (content.episode ?? null)) {
      return { status: 'blocked', reason: 'content-mismatch' };
    }
    return applyAction(msg);
  }

  function tick() {
    const target = remoteEstimate();
    if (target === null) return { action: 'none', reason: 'no-remote-state', drift: 0 };
    if (pending) return { action: 'none', reason: 'pending-play', drift: 0 };
    if (remote.playing && !playing) return { action: 'none', reason: 'local-paused', drift: 0 };

    const drift = player.getCurrentTime() - target;
    const abs = Math.abs(drift);

    // Histerese: quem esta com rate ajustado so volta ao normal perto de zero.
    if (abs <= (rateAdjusted ? tolerance / 2 : tolerance)) {
      return { action: restoreRate() ? 'rate-restored' : 'none', drift };
    }
    const canRate = remote.playing && playing && typeof player.setPlaybackRate === 'function';
    if (canRate && abs <= seekThreshold) {
      const rate = drift > 0 ? 1 - rateDelta : 1 + rateDelta;
      player.setPlaybackRate(rate);
      rateAdjusted = true;
      return { action: 'rate', drift, rate };
    }
    restoreRate();
    const to = Math.max(0, target);
    applyToPlayer('seek', () => player.seek(to));
    return { action: 'seek', drift, to };
  }

  return {
    localPlay() {
      playing = true;
      pending = null;
      return local('play', { time: player.getCurrentTime(), playing: true });
    },
    localPause() {
      playing = false;
      return local('pause', { time: player.getCurrentTime(), playing: false });
    },
    localSeek(time) {
      return local('seek', { time: isNum(time) ? time : player.getCurrentTime(), playing });
    },
    sendState: () => emit(build('state', { time: player.getCurrentTime(), playing })),
    ping: () => emit(build('ping', { t0: now() })),
    receive,
    tick,
    getLatency,
    getPending: () => (pending ? { ...pending } : null),
    clearPending() { pending = null; },
    async resumePending() {
      if (!pending) return { status: 'applied', reason: 'nothing-pending' };
      const target = remote && remote.playing ? remoteEstimate() : undefined;
      pending = null;
      return startPlayback(target);
    },
    resetPeer() { peerId = null; lastPeerSeq = -1; remote = null; },
  };
}
