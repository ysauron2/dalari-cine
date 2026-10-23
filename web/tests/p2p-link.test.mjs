import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { P2PLink, encodeCode, decodeCode, looksLikeCode, isAllowedGuestRoute } = require('../server/p2p-link.js');
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');

// RTCPeerConnection falso: dois pares se ligam trocando o SDP e o canal entrega mensagens ao outro lado.
const registry = new Map();
let seq = 0;
class FakeChannel extends EventTarget {
  constructor() { super(); this.readyState = 'connecting'; this.sent = []; }
  send(text) { this.sent.push(text); const peer = this.peer; queueMicrotask(() => { if (peer.readyState === 'open') peer.dispatchEvent(Object.assign(new Event('message'), { data: text })); }); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.dispatchEvent(new Event('close')); const p = this.peer; if (p && p.readyState !== 'closed') p.close(); }
}
class FakePC extends EventTarget {
  constructor(config) { super(); this.config = config; this.id = ++seq; this.iceGatheringState = 'complete'; this.signalingState = 'stable'; this.connectionState = 'new'; registry.set(this.id, this); }
  createDataChannel() { this.channel = new FakeChannel(); return this.channel; }
  async createOffer() { return { type: 'offer', sdp: `v=0\r\no=fake ${this.id}\r\na=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n` }; }
  async createAnswer() { return { type: 'answer', sdp: `v=0\r\no=fake ${this.id}\r\na=candidate:1 1 udp 1 192.0.2.2 9 typ host\r\n` }; }
  async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d) {
    this.remoteDescription = d; this.signalingState = 'stable';
    const other = registry.get(Number(/o=fake (\d+)/.exec(d.sdp)[1]));
    if (d.type === 'answer') {
      this.connectionState = 'connected';
      const guestChannel = new FakeChannel();
      guestChannel.peer = this.channel; this.channel.peer = guestChannel;
      other.dispatchEvent(Object.assign(new Event('datachannel'), { channel: guestChannel }));
      queueMicrotask(() => { guestChannel.readyState = 'open'; this.channel.readyState = 'open'; guestChannel.dispatchEvent(new Event('open')); this.channel.dispatchEvent(new Event('open')); });
    }
  }
  close() { this.connectionState = 'closed'; }
}
const ICE = [{ urls: 'stun:stun.example.test:3478' }];

async function linkPair(extra) {
  const host = new P2PLink({ RTC: FakePC, iceServers: ICE });
  const guest = new P2PLink({ RTC: FakePC, iceServers: ICE });
  const offer = await host.createOffer(extra);
  const { answer, extra: got } = await guest.acceptOffer(offer);
  await host.acceptAnswer(answer);
  await Promise.all([host.opened, guest.opened]);
  return { host, guest, offer, answer, got };
}

test('códigos: ida e volta, convite embutido, e entradas inválidas são recusadas', () => {
  const code = encodeCode('offer', 'v=0\r\na=candidate:x', { invite: '123456.abc' });
  assert.equal(code.startsWith('DT1.'), true);
  assert.equal(looksLikeCode(`  ${code}\n`), true);
  assert.equal(looksLikeCode('123456.abc'), false);
  assert.deepEqual(decodeCode(`${code.slice(0, 20)}\n ${code.slice(20)}`), { type: 'offer', sdp: 'v=0\r\na=candidate:x', extra: { invite: '123456.abc' } });
  for (const bad of ['', 'DT1.', 'DT1.@@@', 'DT2.abc', 'DT1.' + 'A'.repeat(20000), encodeCode('offer', 'não-é-sdp'), 'DT1.' + Buffer.from('{"v":2}').toString('base64url'), 'DT1.' + Buffer.from('{"v":1,"t":"o","s":5}').toString('base64url')]) {
    assert.throws(() => decodeCode(bad), /inválido/, bad.slice(0, 30));
  }
});

test('lista de rotas permitidas ao convidado: nada de criar sala, admissão, convite ou encerrar', () => {
  const ok = [['GET', '/v1/rooms/123456/state?after=0&wait=25'], ['GET', '/v1/rooms/123456/ice'], ['GET', '/v1/rooms/123456/youtube/search?q=lofi'],
    ['POST', '/v1/rooms/123456/join'], ['POST', '/v1/rooms/123456/actions'], ['POST', '/v1/rooms/123456/profile'], ['POST', '/v1/rooms/123456/leave']];
  for (const [m, p] of ok) assert.equal(isAllowedGuestRoute(m, p), true, `${m} ${p}`);
  const bad = [['POST', '/v1/rooms'], ['POST', '/v1/rooms/123456/admission'], ['POST', '/v1/rooms/123456/invite'], ['POST', '/v1/rooms/123456/close'],
    ['GET', '/healthz'], ['GET', '/'], ['GET', '/server/online-ui.js'], ['GET', '/v1/rooms/123456/state'], ['GET', '/v1/rooms/12345/ice'], ['DELETE', '/v1/rooms/123456/leave'],
    ['POST', '/v1/rooms/123456/actions?x=1'], ['GET', '/v1/rooms/123456/ice?token=1'], ['POST', '//evil.test/v1/rooms/123456/join'], ['GET', 'http://evil.test/v1/rooms/123456/ice']];
  for (const [m, p] of bad) assert.equal(isAllowedGuestRoute(m, p), false, `${m} ${p}`);
});

test('oferta/resposta abrem o canal; o convite viaja dentro da oferta; a resposta só vale para a oferta certa', async () => {
  const { host, guest, got, offer, answer } = await linkPair({ invite: '654321.segredo' });
  assert.deepEqual(got, { invite: '654321.segredo' });
  assert.equal(host.state, 'open'); assert.equal(guest.state, 'open');
  assert.deepEqual(host.pc.config.iceServers, ICE);
  const other = new P2PLink({ RTC: FakePC });
  await other.createOffer();
  await assert.rejects(() => other.acceptAnswer(offer), /não corresponde/);          // código errado
  const fresh = new P2PLink({ RTC: FakePC });
  await assert.rejects(() => fresh.acceptAnswer(answer), /não corresponde/);          // sem oferta pendente
  await assert.rejects(() => new P2PLink({ RTC: FakePC }).acceptOffer(answer), /resposta/);
  host.close(); guest.close();
});

test('convidado fala com o serviço real do Host pelo canal: entra, é aprovado, recebe estado e ICE', async () => {
  const ice = [{ urls: 'stun:stun.example.test:3478' }];
  const svc = createRoomService({ iceServers: ice });
  const addr = await svc.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const hostClient = new DuoRoomClient({ serviceUrl: base });
    const created = await hostClient.createRoom('Host');
    const { host, guest, got } = await linkPair({ invite: created.invite });
    host.serve(P2PLink.localHandler(globalThis.fetch.bind(globalThis), base));
    const guestClient = new DuoRoomClient({ serviceUrl: base, fetchImpl: guest.fetch });
    await guestClient.joinRoom(got.invite, 'Convidada');
    await hostClient.approveGuest();
    const snap = await guestClient.getState({ after: 0 });
    assert.equal(snap.status, 'active');
    assert.deepEqual(await guestClient.iceServers(), ice);
    await guestClient.send('voice.ready', { ready: true });   // ação autenticada também atravessa o canal
    host.close(); guest.close();
  } finally { await svc.close(); }
});

test('o Host recusa rotas fora da lista, não repassa cabeçalhos extras', async () => {
  const { host, guest } = await linkPair();
  const seen = [];
  host.serve(async (req) => { seen.push(req); return { status: 200, body: '{"ok":true}' }; });
  const forbidden = await guest.fetch('http://x.test/v1/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  assert.equal(seen.length, 0);
  const res = await guest.fetch('http://x.test/v1/rooms/123456/ice', { headers: { Authorization: 'Bearer t', Cookie: 'x=1', Host: 'evil' } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen[0].headers, { authorization: 'Bearer t' });
  host.close(); guest.close();
});

test('o Host limita requisições simultâneas de um convidado (429)', async () => {
  const { host, guest } = await linkPair();
  host.serve(() => new Promise(() => {}));
  for (let i = 0; i < 8; i++) void guest.fetch('http://x.test/v1/rooms/123456/ice').catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  const ninth = await guest.fetch('http://x.test/v1/rooms/123456/ice');
  assert.equal(ninth.status, 429);
  host.close(); guest.close();
});

test('respostas grandes são divididas em partes e remontadas; cancelar aborta no Host', async () => {
  const { host, guest } = await linkPair();
  const big = JSON.stringify({ ok: true, texto: 'á'.repeat(100000) });
  let aborted = false;
  host.serve(async (req) => {
    if (req.path.includes('state')) return new Promise((resolve) => req.signal.addEventListener('abort', () => { aborted = true; resolve({ status: 200, body: '{}' }); }));
    return { status: 200, body: big };
  });
  const res = await guest.fetch('http://x.test/v1/rooms/123456/ice');
  assert.equal((await res.json()).texto.length, 100000);
  assert.ok(host.channel.sent.length > 8, 'dividido em várias mensagens');
  const ctl = new AbortController();
  const pending = guest.fetch('http://x.test/v1/rooms/123456/state?after=0&wait=25', { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 20));
  ctl.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(aborted, true);
  host.close(); guest.close();
});

test('fechar o canal rejeita requisições em andamento; sem canal aberto não envia nada', async () => {
  const { host, guest } = await linkPair();
  host.serve(() => new Promise(() => {}));
  const pending = guest.fetch('http://x.test/v1/rooms/123456/ice');
  await new Promise((r) => setTimeout(r, 10));
  host.close();
  await assert.rejects(pending, /encerrada/);
  await assert.rejects(guest.fetch('http://x.test/v1/rooms/123456/ice'), /não está aberta/);
  const idle = new P2PLink({ RTC: FakePC });
  await assert.rejects(idle.fetch('http://x.test/v1/rooms/123456/ice'), /não está aberta/);
});

// SDP real gerado pelo Chrome para um canal de dados (oferta).
const CHROME_OFFER = 'v=0\r\no=- 8114197335480902002 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\nm=application 59377 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 200.195.87.40\r\na=candidate:4294665965 1 udp 2113937151 18539395-4938-43a8-bb35-f600595141ff.local 56824 typ host generation 0 network-cost 999\r\na=candidate:1442262400 1 udp 1677729535 200.195.87.40 59377 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999\r\na=ice-ufrag:G+BK\r\na=ice-pwd:xHSHTwMmBDHfbC//kW6y4LP4\r\na=ice-options:trickle\r\na=fingerprint:sha-256 4C:1D:9D:0F:85:D4:3C:E5:42:EE:63:78:68:34:17:31:45:50:46:8D:2D:D5:A4:15:F1:C4:D3:FE:1F:38:49:E2\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n';
const field = (sdp, re) => new RegExp(re, 'm').exec(sdp)?.[1];

test('código compacto (DT2): ~1/10 do tamanho, com o código da sala, e o SDP reconstruído mantém tudo que importa', () => {
  const { encodeCompact } = require('../server/p2p-link.js');
  const code = encodeCompact('offer', CHROME_OFFER, { room: '172737' });
  assert.ok(code.startsWith('DT2.') && code.length < 200, `tamanho ${code.length}`);   // com nome mDNS; com IPs puros (app) fica menor
  const bare = encodeCompact('offer', CHROME_OFFER.replace('18539395-4938-43a8-bb35-f600595141ff.local', '192.168.0.181'), { room: '172737' });
  assert.ok(bare.length < 140, `tamanho ${bare.length}`);
  assert.equal(looksLikeCode(code), true);
  const d = decodeCode(code);
  assert.equal(d.type, 'offer');
  assert.deepEqual(d.extra, { room: '172737' });
  for (const re of ['^a=ice-ufrag:(.+)\r', '^a=ice-pwd:(.+)\r', '^a=fingerprint:sha-256 (.+)\r', '^a=setup:(.+)\r']) assert.equal(field(d.sdp, re), field(CHROME_OFFER, re), re);
  assert.match(d.sdp, /typ srflx raddr 0\.0\.0\.0 rport 0/);
  assert.match(d.sdp, /18539395-4938-43a8-bb35-f600595141ff\.local 56824 typ host/);
  assert.match(d.sdp, /^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel\r$/m);
  assert.equal(encodeCompact('offer', d.sdp, { room: '172737' }), code);       // idempotente
  const answer = decodeCode(encodeCompact('answer', CHROME_OFFER.replace('actpass', 'active')));
  assert.equal(answer.type, 'answer'); assert.match(answer.sdp, /a=setup:active/); assert.equal(answer.extra, undefined);
});

test('código compacto: IPv6, descarta link-local, rejeita SDP/código adulterado e cai para o formato completo se faltar algo', () => {
  const { encodeCompact } = require('../server/p2p-link.js');
  const v6 = CHROME_OFFER.replace('a=ice-ufrag', 'a=candidate:1 1 udp 2113937151 2804:14c:1234:5678:9abc:def0:1234:5678 50000 typ host generation 0\r\na=candidate:2 1 udp 2113937151 fe80::1 50001 typ host generation 0\r\na=ice-ufrag');
  const d = decodeCode(encodeCompact('offer', v6, { room: '000042' }));
  assert.match(d.sdp, /2804:14c:1234:5678:9abc:def0:1234:5678 50000 typ host/);
  assert.doesNotMatch(d.sdp, /fe80/);
  assert.deepEqual(d.extra, { room: '000042' });
  assert.equal(encodeCompact('offer', 'v=0\r\nsem candidatos\r\n'), null);
  assert.equal(encodeCompact('offer', CHROME_OFFER, { invite: 'x' }), null);
  const good = encodeCompact('offer', CHROME_OFFER, { room: '172737' });
  for (const bad of [good.slice(0, -4), good + 'AAAA', 'DT2.', 'DT2.@@@', 'DT2.' + 'A'.repeat(2000)]) assert.throws(() => decodeCode(bad), /inválido/, bad.slice(0, 20));
});

test('com SDP real o convidado entra só com o código compacto: o Host injeta o convite, que nunca vai no código', async () => {
  const svc = createRoomService();
  const addr = await svc.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const hostClient = new DuoRoomClient({ serviceUrl: base });
    const created = await hostClient.createRoom('Host');
    const secret = created.invite.split('.')[1];
    const { host, guest, got, offer } = await linkPair({ room: hostClient.code });
    assert.deepEqual(got, { room: hostClient.code });
    assert.equal(offer.includes(secret), false);
    const local = P2PLink.localHandler(globalThis.fetch.bind(globalThis), base);
    host.serve(async (req) => {
      if (req.method === 'POST' && req.path === `/v1/rooms/${hostClient.code}/join`) req = { ...req, body: JSON.stringify({ ...JSON.parse(req.body), inviteSecret: secret }) };
      return local(req);
    });
    const guestClient = new DuoRoomClient({ serviceUrl: base, fetchImpl: guest.fetch });
    await guestClient.joinRoom(`${got.room}.${'A'.repeat(43)}`, 'Convidada');
    await hostClient.approveGuest();
    assert.equal((await guestClient.getState({ after: 0 })).status, 'active');
    host.close(); guest.close();
  } finally { await svc.close(); }
});

test('código compacto com retransmissor: os candidatos locais e o relay não são expulsos por vários srflx', () => {
  const { encodeCompact } = require('../server/p2p-link.js');
  const cand = (n, type, addr, port) => `a=candidate:${n} 1 udp ${1000 - n} ${addr} ${port} typ ${type}${type === 'host' ? '' : ' raddr 0.0.0.0 rport 0'} generation 0 network-cost 999`;
  const build = (lines) => ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...lines,
    'a=ice-ufrag:abcd', 'a=ice-pwd:' + 'p'.repeat(24), 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', ''].join('\r\n');
  const types = (sdp) => decodeCode(encodeCompact('offer', sdp)).sdp.match(/typ \w+/g).map((t) => t.slice(4));
  const crowded = build([cand(1, 'host', '192.168.0.10', 50001), cand(2, 'host', '10.0.0.5', 50002), cand(3, 'host', '172.16.0.9', 50003),
    ...[1, 2, 3, 4, 5].map((i) => cand(3 + i, 'srflx', '200.1.1.1', 41000 + i)), ...[1, 2, 3].map((i) => cand(8 + i, 'relay', '162.159.1.1', 51000 + i))]);
  const out = types(crowded);
  assert.equal(out.length, 5);
  assert.ok(out.includes('host') && out.includes('relay') && out.includes('srflx'), out.join());
  assert.equal(out.filter((t) => t === 'relay').length, 1);
  // sem espaço disputado, nada muda: srflx primeiro, depois host
  assert.deepEqual(types(build([cand(1, 'host', '192.168.0.10', 50001), cand(2, 'srflx', '200.1.1.1', 41000)])), ['srflx', 'host']);
  // só relay (conexão forçada pelo retransmissor): usa o espaço todo
  assert.equal(types(build([1, 2, 3, 4, 5, 6].map((i) => cand(i, 'relay', '162.159.1.1', 51000 + i)))).length, 5);
});
