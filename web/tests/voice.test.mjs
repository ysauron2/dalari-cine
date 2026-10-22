import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');
const { VoiceCall } = require('../server/voice.js');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 80; i++) { if (check()) return; await pause(15); }
  assert.fail('A negociação de voz não avançou no tempo esperado.');
}

test('dois participantes ligam, negociam, silenciam e desligam a voz sem nova aprovação', async () => {
  const old = { document: globalThis.document, navigator: globalThis.navigator, RTCPeerConnection: globalThis.RTCPeerConnection };
  const tracks = [];
  const pcs = [];
  class FakePC extends EventTarget {
    constructor(config) { super(); this.config = config; this.iceGatheringState = 'complete'; this.signalingState = 'stable'; this.connectionState = 'new'; pcs.push(this); }
    addTrack() {}
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\no=host\r\n' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0\r\no=guest\r\n' }); }
    async setLocalDescription(value) { this.localDescription = value; this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = 'stable'; }
    close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ setAttribute() {}, play: async () => {}, volume: 1, srcObject: null }) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
    const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } } });
  globalThis.RTCPeerConnection = FakePC;
  const ice = [{ urls: 'stun:stun.example.test:3478' }];
  const service = createRoomService({ iceServers: ice });
  try {
    const addr = await service.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${addr.port}`;
    const host = new DuoRoomClient({ serviceUrl: base }), guest = new DuoRoomClient({ serviceUrl: base });
    const created = await host.createRoom('Host');
    await guest.joinRoom(created.invite, 'Convidado');
    await host.approveGuest();
    await host.getState({ after: 0 }); await guest.getState({ after: 0 });
    const hv = new VoiceCall(), gv = new VoiceCall();
    hv.attach(host); gv.attach(guest);
    await hv.join();
    await guest.getState({ after: 0 }); gv.update(guest.snapshot);
    await gv.join();
    await host.getState({ after: 0 }); hv.update(host.snapshot);
    await until(() => host.snapshot?.voice?.hasOffer);
    await guest.getState({ after: 0 }); gv.update(guest.snapshot);
    await until(() => guest.snapshot?.voice?.hasAnswer);
    await host.getState({ after: 0 }); hv.update(host.snapshot);
    await until(() => hv.peer?.remoteDescription?.type === 'answer');
    assert.equal(gv.peer.remoteDescription.type, 'offer');
    assert.equal(hv.toggleMute(), true);
    assert.equal(tracks[0].enabled, false);
    hv.setVolume(0.4);
    assert.equal(hv.audio.volume, 0.4);
    await gv.leave();
    await host.getState({ after: 0 }); hv.update(host.snapshot);
    assert.equal(hv.state, 'waiting');
    assert.equal(tracks[1].stopped, true);
    await hv.leave();
    assert.equal(tracks[0].stopped, true);
    assert.ok(pcs.length >= 2);
    for (const pc of pcs) assert.deepEqual(pc.config.iceServers, ice);   // voz usa o STUN/TURN entregue pela sala
  } finally {
    await service.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  }
});

test('a coleta de candidatos não precisa terminar: segue com o que há após o prazo curto, e só falha se não houver nenhum', async () => {
  const { ICE, waitForIce } = require('../server/voice.js');
  const saved = { ...ICE };
  const gathering = (sdp) => Object.assign(new EventTarget(), { iceGatheringState: 'gathering', signalingState: 'have-local-offer', localDescription: sdp ? { sdp } : null });
  try {
    ICE.softMs = 10; ICE.hardMs = 80;
    const t0 = Date.now();
    await waitForIce(gathering('v=0\r\na=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n'));      // placa lenta: não derruba a voz
    assert.ok(Date.now() - t0 < 70);
    await assert.rejects(() => waitForIce(gathering('v=0\r\n')), /não concluiu/);               // sem nenhum candidato: falha mesmo
    const done = gathering('x'); done.iceGatheringState = 'complete';
    await waitForIce(done);
  } finally { Object.assign(ICE, saved); }
});
