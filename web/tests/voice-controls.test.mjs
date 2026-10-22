import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { VoiceCall, SPEECH } = require('../server/voice.js');

function env() {
  const saved = { document: globalThis.document, navigator: globalThis.navigator, localStorage: globalThis.localStorage };
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ setAttribute() {}, play: async () => {}, volume: 1, srcObject: null }) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {} } });
  return { store, restore: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, { configurable: true, value: v }); } } };
}
const withStream = (v) => { const t = { kind: 'audio', enabled: true }; v.stream = { getTracks: () => [t], getAudioTracks: () => [t] }; return t; };

test('push-to-talk: calado até apertar a tecla; mudo vence; desligar o modo devolve o microfone; configuração é lembrada', () => {
  const e = env();
  try {
    const v = new VoiceCall(); const track = withStream(v);
    assert.equal(v.ptt.on, false); assert.equal(v.ptt.code, 'Backquote');
    v.pttPress(true); assert.equal(track.enabled, true, 'fora do modo PTT a tecla não faz nada e o microfone segue aberto');
    v.setPtt(true, 'KeyV');
    assert.equal(track.enabled, false);
    v.pttPress(true); assert.equal(track.enabled, true);
    v.pttPress(false); assert.equal(track.enabled, false);
    v.pttPress(true); v.toggleMute(); assert.equal(track.enabled, false, 'mudo vence a tecla apertada');
    v.toggleMute(); assert.equal(track.enabled, true);
    v.setPtt(false);
    assert.equal(track.enabled, true, 'sem PTT o microfone volta a abrir (não mudo)');
    assert.deepEqual(JSON.parse(e.store.get('duotela-ptt')), { on: false, code: 'KeyV' });
    v.setPtt(true, '<script>');
    assert.equal(v.ptt.code, 'KeyV', 'tecla inválida é ignorada');
    assert.equal(new VoiceCall().ptt.on, true, 'a próxima sessão lembra');
  } finally { e.restore(); }
});

test('volume por pessoa multiplica o volume geral e não vaza para outras pessoas', () => {
  const e = env();
  try {
    const v = new VoiceCall();
    const a1 = v.makeAudio(), a2 = v.makeAudio();
    v.peers.set('guest', { audio: a1 }); v.peers.set('guest2', { audio: a2 });
    v.setPeerVolume('guest', 0.5);
    assert.equal(a1.volume, 0.5); assert.equal(a2.volume, 1);
    v.setVolume(0.8);
    assert.equal(a1.volume, 0.4); assert.equal(a2.volume, 0.8);
    v.setPeerVolume('guest2', 2);                              // acima de 100% é limitado
    assert.equal(a2.volume, 0.8);
    v.setPeerVolume('guest', -1); assert.equal(a1.volume, 0);
    const entry = { audio: null }; v.peers.set('guest3', entry); v.setPeerVolume('guest3', 0.25);
    const el = v.audioFor(entry);                              // áudio novo já nasce no volume da pessoa
    assert.equal(el.volume, 0.2);
  } finally { e.restore(); }
});

function statsPc(levels) {
  return { connectionState: 'connected', getStats: async () => new Map([['i', { type: 'inbound-rtp', kind: 'audio', audioLevel: levels.remote }], ['m', { type: 'media-source', kind: 'audio', audioLevel: levels.local ?? 0 }]]) };
}

test('quem está falando: liga acima do limite, segura o resto, desliga depois; você some quando está mudo; só avisa quando muda', async () => {
  const e = env();
  try {
    const events = [];
    const v = new VoiceCall({ onSpeaking: (s) => events.push(Object.keys(s).filter((k) => s[k]).sort().join(',')) });
    withStream(v);
    const levels = { remote: 0, local: 0 };
    v.peers.set('guest', { pc: statsPc(levels) });
    let t = 1000;
    levels.remote = 0.001; await v.pollSpeech(t);               // silêncio: nada
    assert.deepEqual(events, []);
    levels.remote = 0.15; await v.pollSpeech(t += 150);          // fala
    assert.deepEqual(events, ['guest']);
    await v.pollSpeech(t += 150); assert.deepEqual(events, ['guest'], 'sem repetir o aviso');
    levels.remote = 0.001; await v.pollSpeech(t += 150);         // pausa curta: ainda "falando"
    assert.equal(v.speaking.guest, true);
    await v.pollSpeech(t += SPEECH.holdMs + 50);                 // passou o resto
    assert.equal(v.speaking.guest, false);
    assert.equal(events.at(-1), '');
    levels.local = 0.2; await v.pollSpeech(t += 150);            // você falando
    assert.equal(events.at(-1), 'local');
    v.muted = true; await v.pollSpeech(t += 150);
    levels.local = 0.2; await v.pollSpeech(t += SPEECH.holdMs + 200);
    assert.equal(v.speaking.local, false, 'mudo não aparece como falando');
    v.peers.delete('guest'); levels.remote = 0.5; v.speaking.guest = true;
    await v.pollSpeech(t += 150);
    assert.equal('guest' in v.speaking, false, 'quem saiu da sala sai do indicador');
  } finally { e.restore(); }
});
