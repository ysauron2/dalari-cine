// Teste de verdade do retransmissor (TURN): pede credenciais ao Worker publicado e abre uma conexão WebRTC entre duas pontas
// FORÇANDO a passagem pelo retransmissor (iceTransportPolicy: 'relay'): se o canal abrir e trocar mensagens, o TURN funciona.
// Precisa de internet e dos segredos TURN_KEY_ID / TURN_KEY_API_TOKEN já guardados no Worker.
// Uso: node tools/e2e-turn.mjs [endereco-do-worker]
import { launch } from './cdp.mjs';

const WORKER = (process.argv[2] || 'https://dalari-stats.dalaricine.workers.dev').replace(/\/+$/, '');
const res = await fetch(WORKER + '/v1/ice');
const body = await res.json().catch(() => ({}));
console.log(`Worker /v1/ice -> HTTP ${res.status}`, body.ok ? `ttl ${body.ttl}s, ${body.iceServers.length} servidores` : JSON.stringify(body));
if (!res.ok || !body.ok) { console.log('FALHA: o Worker não entregou credenciais (segredos guardados? Worker publicado?).'); process.exit(1); }
const turn = body.iceServers.find((s) => s.username);
console.log('endereços TURN:', turn.urls.join(' '));

const chrome = await launch();
let ok = false;
try {
  const p = await chrome.browser.page();
  await p.goto('about:blank');
  const out = await p.evaluate(async (servers) => {
    const log = [];
    const cfg = { iceServers: servers, iceTransportPolicy: 'relay' };
    const a = new RTCPeerConnection(cfg), b = new RTCPeerConnection(cfg);
    const types = new Set();
    const gather = (pc) => new Promise((resolve) => { const t = setTimeout(resolve, 8000); pc.onicecandidate = (e) => { if (!e.candidate) { clearTimeout(t); resolve(); } else types.add(/ typ (\w+)/.exec(e.candidate.candidate)?.[1]); }; });
    const dc = a.createDataChannel('t');
    const opened = new Promise((resolve) => { dc.onopen = () => resolve('open'); setTimeout(() => resolve('timeout'), 20000); });
    const got = new Promise((resolve) => { b.ondatachannel = (e) => { e.channel.onmessage = (m) => resolve(m.data); }; setTimeout(() => resolve(null), 20000); });
    const ga = gather(a); await a.setLocalDescription(await a.createOffer()); await ga;
    await b.setRemoteDescription(a.localDescription);
    const gb = gather(b); await b.setLocalDescription(await b.createAnswer()); await gb;
    await a.setRemoteDescription(b.localDescription);
    const state = await opened;
    if (state === 'open') dc.send('ola pelo retransmissor');
    const msg = await got;
    log.push(`canal: ${state}`, `mensagem recebida: ${msg}`, `tipos de candidato: ${[...types].join(',')}`);
    const stats = await a.getStats(); let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
    if (pair) { const l = stats.get(pair.localCandidateId); log.push(`par escolhido: local ${l?.candidateType} (${l?.relayProtocol || l?.protocol})`); }
    a.close(); b.close();
    return { state, msg, types: [...types], log };
  }, body.iceServers);
  out.log.forEach((l) => console.log(' ', l));
  ok = out.state === 'open' && out.msg === 'ola pelo retransmissor' && out.types.length > 0 && out.types.every((t) => t === 'relay');
  console.log(ok ? 'OK   conexão aberta SÓ pelo retransmissor e mensagem trocada' : 'FALHA o retransmissor não deixou a conexão abrir');
} finally { await chrome.close(); }
process.exit(ok ? 0 : 1);
