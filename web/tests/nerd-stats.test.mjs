import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NerdStats, rtcSummary } = require('../server/nerd-stats.js');

// Estatísticas no formato do getStats(): inclui IPs de propósito, para provar que o relatório não os repete.
function fakePc(over = {}) {
  const rows = [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P', dtlsState: 'connected', dtlsCipher: 'TLS_AES_128_GCM', srtpCipher: 'AES_CM_128_HMAC_SHA1_80', iceState: 'connected' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042, availableOutgoingBitrate: 512000, bytesSent: 1000, bytesReceived: 2000 },
    { id: 'L', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', networkType: 'wifi', address: '200.195.87.40' },
    { id: 'R', type: 'remote-candidate', candidateType: 'host', address: '192.168.0.109' },
    { id: 'C', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1' },
    { id: 'I', type: 'inbound-rtp', kind: 'audio', codecId: 'C', packetsReceived: 95, packetsLost: 5, jitter: 0.012, bytesReceived: over.inBytes ?? 10000, audioLevel: 0.25, totalSamplesReceived: 1000, concealedSamples: 50, jitterBufferDelay: 2, jitterBufferEmittedCount: 100 },
    { id: 'O', type: 'outbound-rtp', kind: 'audio', packetsSent: 120, bytesSent: over.outBytes ?? 8000, targetBitrate: 32000 },
    { id: 'RI', type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 0.05, fractionLost: 0.02, jitter: 0.004 },
    { id: 'D', type: 'data-channel', state: 'open', messagesSent: 7, messagesReceived: 9, bytesSent: 700, bytesReceived: 900 },
  ];
  return { connectionState: 'connected', iceConnectionState: 'connected', signalingState: 'stable', iceGatheringState: 'complete', getStats: async () => new Map(rows.map((r) => [r.id, r])) };
}

const env = { navigator: { userAgent: 'Mozilla/5.0 (X11) Chrome/150', onLine: true, hardwareConcurrency: 8, deviceMemory: 16, language: 'pt-BR', connection: { effectiveType: '4g', rtt: 50, downlink: 10 } }, isSecureContext: true, crypto: { subtle: {} }, screen: { width: 1920, height: 1080 }, devicePixelRatio: 1, performance: { memory: { usedJSHeapSize: 5 * 1048576, jsHeapSizeLimit: 2048 * 1048576 } } };
const section = (secs, title) => secs.find((s) => s.title === title)?.rows || [];
const text = (rows) => rows.map(([k, v]) => `${k} ${v}`).join('\n');

test('sem sala nem voz: coleta sem lançar e diz "não conectado"', async () => {
  const stats = new NerdStats(() => ({}), { env });
  const secs = await stats.collect();
  assert.equal(section(secs, 'Sala')[0][1], 'não conectado');
  assert.match(text(section(secs, 'Aplicativo e navegador')), /Navegador/);
  assert.match(text(section(secs, 'Aplicativo e navegador')), /4g/);
  assert.match(NerdStats.toText(secs), /== Sala ==/);
});

test('contexto completo: sala, túnel, voz com perda/jitter/taxas; e o relatório não vaza IPs, convites nem credenciais', async () => {
  let clock = 1_000_000;
  const peer = { pc: fakePc({ inBytes: 10000, outBytes: 8000 }), state: 'connected', session: 3, initiator: true };
  const link = { pc: fakePc(), state: 'open', stats: { sent: 12, failed: 1, lastMs: 33, avgMs: 41, served: 0, rejected: 2 } };
  const ctx = {
    client: { role: 'host', metrics: { calls: 10, errors: 1, lastMs: 30, avgMs: 28, maxMs: 90, polls: 4, lastPollMs: 25000, lastError: 'stale_seq' } },
    snapshot: { status: 'active', revision: 42, yourLastSeq: 7, participants: ['host', 'guest'], capacity: 4, pendingGuests: [], presence: { host: true, guest: true }, platform: 'youtube', media: { provider: 'youtube', videoId: 'abc123' }, round: null, serverTime: clock + 120, playback: { state: 'playing', positionSec: 100, version: 5, updatedBy: 'host' } },
    voice: { state: 'connected', joined: true, muted: false, volume: 0.8, autoRetries: 1, inputId: 'mic', outputId: '', canSelectOutput: true,
      stream: { getAudioTracks: () => [{ label: 'Headset USB', readyState: 'live', muted: false, getSettings: () => ({ sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }) }] },
      peers: new Map([['guest', peer]]) },
    youtube: { currentPosition: () => 100.6, syncedPosition: () => 100.0 },
    hostLinks: [link], extra: { status: 'connected' },
  };
  const stats = new NerdStats(() => ctx, { env, now: () => clock });
  stats.log('voz: connected');
  let secs = await stats.collect();
  clock += 2000; peer.pc = fakePc({ inBytes: 10000 + 32000, outBytes: 8000 + 8000 });   // +32 kB em 2 s = 128 kbit/s
  secs = await stats.collect();
  const voice = text(section(secs, 'Voz')), room = text(section(secs, 'Sala')), links = text(section(secs, 'Conexão direta (WebRTC)'));
  assert.match(voice, /opus 48000Hz 2ch/);
  assert.match(voice, /perda 5\.0% \(5\/100\)/);
  assert.match(voice, /jitter 12\.0 ms/);
  assert.match(voice, /128\.0 kbit\/s/);              // taxa de recepção calculada entre duas coletas
  assert.match(voice, /srflx→host udp \(wifi\)/);
  assert.match(voice, /Headset USB/);
  assert.match(voice, /perda 2\.0%/);                 // como o outro lado nos vê
  assert.match(room, /Revisão do estado \/ seq 42 · seq 7/);
  assert.match(room, /média 28 ms/);
  assert.match(room, /\+0\.60 s \(player − sala\)/);  // deriva do player
  assert.match(links, /túnel de requisições enviadas 12 \(falhas 1\)/);
  assert.match(links, /canal de dados open/);
  const report = NerdStats.toText(secs);
  assert.match(report, /== Eventos recentes ==/);
  assert.doesNotMatch(report, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'nenhum IP no relatório');
  assert.doesNotMatch(report, /200\.195|192\.168|Bearer|inviteSecret|a=candidate|v=0/);
});

test('rtcSummary não quebra com getStats ausente ou com falha', async () => {
  const out = await rtcSummary({ connectionState: 'new', iceConnectionState: 'new', signalingState: 'stable', iceGatheringState: 'new', getStats: async () => { throw new Error('x'); } });
  assert.equal(out.conn, 'new');
  assert.equal(out.route, undefined);
});

test('histórico de eventos guarda só os últimos 40', () => {
  const stats = new NerdStats(() => ({}), { env });
  for (let i = 0; i < 60; i++) stats.log('evento ' + i);
  assert.equal(stats.events.length, 40);
  assert.match(stats.events.at(-1), /evento 59$/);
  assert.match(stats.events[0], /evento 20$/);
});
