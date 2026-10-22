import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { VoiceCall } = require('../server/voice.js');

function setup({ devices = [], sink = true, failDevices = [] } = {}) {
  const saved = { document: globalThis.document, navigator: globalThis.navigator, localStorage: globalThis.localStorage };
  const store = new Map();
  const audios = [];
  const requested = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => {
    const a = { sinks: [], setAttribute() {}, play: async () => {}, volume: 1, srcObject: null };
    if (sink) a.setSinkId = async (id) => { if (id === 'quebrado') throw new Error('x'); a.sinks.push(id); };
    audios.push(a); return a;
  } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => devices,
    getUserMedia: async ({ audio }) => {
      const id = audio?.deviceId?.exact;
      requested.push(id ?? null);
      if (id && failDevices.includes(id)) { const e = new Error('nao existe'); e.name = 'OverconstrainedError'; throw e; }
      const track = { kind: 'audio', enabled: true, stopped: false, deviceId: id ?? 'padrao', stop() { this.stopped = true; } };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  } } });
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, { configurable: true, value: v }); } };
  return { store, audios, requested, restore };
}

test('lista de dispositivos: esconde "default"/"communications", dá nome genérico sem permissão e diz se há seleção de saída', async () => {
  const env = setup({ devices: [
    { kind: 'audioinput', deviceId: 'default', label: 'Padrão - Mic' }, { kind: 'audioinput', deviceId: 'mic1', label: 'Headset USB' }, { kind: 'audioinput', deviceId: 'mic2', label: '' },
    { kind: 'audiooutput', deviceId: 'communications', label: 'Comunicações' }, { kind: 'audiooutput', deviceId: 'spk1', label: 'Caixas' }, { kind: 'videoinput', deviceId: 'cam', label: 'Câmera' },
  ] });
  try {
    const d = await new VoiceCall().listDevices();
    assert.deepEqual(d.inputs, [{ id: 'mic1', label: 'Headset USB' }, { id: 'mic2', label: 'Microfone 2' }]);
    assert.deepEqual(d.outputs, [{ id: 'spk1', label: 'Caixas' }]);
    assert.equal(d.canSelectOutput, true); assert.equal(d.labeled, true);
  } finally { env.restore(); }
  const env2 = setup({ devices: [{ kind: 'audioinput', deviceId: 'a', label: '' }], sink: false });
  try {
    const d = await new VoiceCall().listDevices();
    assert.equal(d.canSelectOutput, false); assert.equal(d.labeled, false);
    await assert.rejects(() => new VoiceCall().setOutput('x'), /padrão do sistema/);
  } finally { env2.restore(); }
});

test('microfone escolhido é usado ao ligar e lembrado; se sumiu, volta ao padrão e esquece', async () => {
  const env = setup({ failDevices: ['sumiu'] });
  try {
    const v = new VoiceCall();
    v.inputId = 'mic1';
    await v.acquire();
    assert.deepEqual(env.requested, ['mic1']);
    v.inputId = 'sumiu';
    const s = await v.acquire();
    assert.deepEqual(env.requested, ['mic1', 'sumiu', null]);
    assert.equal(s.getAudioTracks()[0].deviceId, 'padrao');
    assert.equal(v.inputId, '');
    assert.equal(JSON.parse(env.store.get('duotela-audio-devices')).input, '');
    assert.equal(new VoiceCall().inputId, '');                    // preferência salva é lida na próxima vez
    env.store.set('duotela-audio-devices', JSON.stringify({ input: 'mic9', output: 'spk9' }));
    const w = new VoiceCall();
    assert.equal(w.inputId, 'mic9'); assert.equal(w.outputId, 'spk9');
    assert.equal(env.audios.at(-1).sinks.at(-1), 'spk9');         // o áudio novo já nasce na saída escolhida
  } finally { env.restore(); }
});

test('trocar o microfone com a voz ligada substitui a faixa em todas as ligações, mantém o mudo e para a antiga', async () => {
  const env = setup();
  try {
    const v = new VoiceCall();
    const oldTrack = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
    v.stream = { getTracks: () => [oldTrack], getAudioTracks: () => [oldTrack] };
    const replaced = [];
    const sender = () => ({ track: oldTrack, replaceTrack: async (t) => { replaced.push(t); } });
    v.peers.set('guest', { pc: { getSenders: () => [sender()] } });
    v.peers.set('guest2', { pc: { getSenders: () => [sender()] } });
    v.muted = true;
    await v.setInput('mic2');
    assert.equal(replaced.length, 2);
    assert.equal(replaced[0], replaced[1]);
    assert.equal(replaced[0].deviceId, 'mic2');
    assert.equal(replaced[0].enabled, false, 'continua mudo');
    assert.equal(oldTrack.stopped, true);
    assert.equal(v.stream.getAudioTracks()[0], replaced[0]);
    assert.equal(JSON.parse(env.store.get('duotela-audio-devices')).input, 'mic2');
  } finally { env.restore(); }
  const env2 = setup({ failDevices: ['ruim'] });
  try {
    const v = new VoiceCall();
    const t = { kind: 'audio', enabled: true, stop() {} };
    v.stream = { getTracks: () => [t], getAudioTracks: () => [t] };
    v.inputId = 'mic1';
    // 'ruim' falha e o acquire cai para o padrão (não lança): a faixa nova é a do padrão
    await v.setInput('ruim');
    assert.equal(v.inputId, '');
  } finally { env2.restore(); }
});

test('saída de áudio: aplica a todos os elementos, lembra, e reverte se o navegador recusar', async () => {
  const env = setup();
  try {
    const v = new VoiceCall();
    v.spareAudio.push(v.makeAudio());
    await v.setOutput('spk1');
    assert.deepEqual(v.audio.sinks, ['spk1']); assert.deepEqual(v.spareAudio[0].sinks, ['spk1']);
    assert.equal(JSON.parse(env.store.get('duotela-audio-devices')).output, 'spk1');
    await assert.rejects(() => v.setOutput('quebrado'), /saída de áudio/);
    assert.equal(v.outputId, 'spk1');
    await v.setOutput('');
    assert.equal(v.audio.sinks.at(-1), '');
  } finally { env.restore(); }
});
