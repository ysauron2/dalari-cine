'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../src/settings-store.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dalari-set-'));

test('só chaves do app, só texto e dentro dos limites passam pela cópia de segurança', () => {
  const ok = S.sanitize({
    'duotela-display-name-v1': '"Kaizen"', 'duotela-telemetry': 'on', 'sessao-a-dois-prototype-v1': '{}',
    'outra-chave': 'x', 'duotela-': 'y', 'duotela-bad key': 'z', 'duotela-numero': 5, 'duotela-objeto': { a: 1 }, 'duotela-grande': 'x'.repeat(S.MAX_VALUE + 1)
  });
  assert.deepEqual(Object.keys(ok).sort(), ['duotela-', 'duotela-display-name-v1', 'duotela-telemetry', 'sessao-a-dois-prototype-v1']);
  for (const bad of [null, undefined, 'texto', 5, [], [1]]) assert.deepEqual(S.sanitize(bad), {});
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['duotela-k' + i, 'v']));
  assert.equal(Object.keys(S.sanitize(many)).length, S.MAX_KEYS);
  const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['duotela-b' + i, 'x'.repeat(190000)]));
  assert.ok(Object.values(S.sanitize(big)).join('').length <= S.MAX_TOTAL);
});

test('grava e lê de volta; arquivo ausente ou corrompido vira vazio; não sobra arquivo temporário', () => {
  const dir = tmp();
  try {
    assert.deepEqual(S.readBackup({ fs, dir }), {});
    assert.equal(S.writeBackup({ fs, dir, data: { 'duotela-display-name-v1': '"Larissa"', lixo: 'x' } }), true);
    assert.deepEqual(S.readBackup({ fs, dir }), { 'duotela-display-name-v1': '"Larissa"' });
    assert.deepEqual(fs.readdirSync(dir), [S.FILE]);
    fs.writeFileSync(path.join(dir, S.FILE), '{ não é json');
    assert.deepEqual(S.readBackup({ fs, dir }), {});
    assert.equal(S.writeBackup({ fs, dir: path.join(dir, S.FILE, 'x'), data: {} }), false, 'erro de disco devolve false, não lança');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('porta do serviço local: só valores válidos são lidos e gravados', () => {
  const dir = tmp();
  try {
    assert.equal(S.readPort({ fs, dir }), 0);
    assert.equal(S.writePort({ fs, dir, port: 51234 }), true);
    assert.equal(S.readPort({ fs, dir }), 51234);
    for (const bad of [0, 80, 1023, 65536, 3.5, '8080', NaN, null]) assert.equal(S.writePort({ fs, dir, port: bad }), false, String(bad));
    fs.writeFileSync(path.join(dir, S.PORT_FILE), 'abc');
    assert.equal(S.readPort({ fs, dir }), 0);
    fs.writeFileSync(path.join(dir, S.PORT_FILE), '99999');
    assert.equal(S.readPort({ fs, dir }), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- o trecho do preload (roda isolado, com um localStorage e um ipcRenderer de mentira) ----
function preload({ stored = {}, backup = {} } = {}) {
  const store = new Map(Object.entries(stored)), sent = [], timers = [], listeners = new Map();
  const localStorage = { get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const ipcRenderer = { sendSync: (ch) => (ch === 'duotela:settings-load' ? backup : null), send: (ch, v) => sent.push({ ch, v }), on() {}, removeListener() {} };
  const context = { require: () => ({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer }), process: { versions: {} }, localStorage, setInterval: (fn) => timers.push(fn), addEventListener: (n, fn) => listeners.set(n, fn) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'duotela-preload.cjs'), 'utf8'), context);
  return { store, sent, tick: () => timers.forEach((f) => f()), pagehide: () => listeners.get('pagehide')?.() };
}

test('armazenamento vazio: restaura da cópia (só as chaves do app) antes de a página ler', () => {
  const p = preload({ backup: { 'duotela-display-name-v1': '"Kaizen"', 'duotela-welcome-v4': '1', 'chave-estranha': 'x' } });
  assert.equal(p.store.get('duotela-display-name-v1'), '"Kaizen"');
  assert.equal(p.store.get('duotela-welcome-v4'), '1');
  assert.equal(p.store.has('chave-estranha'), false);
});

test('armazenamento com dados: não restaura nada por cima (apagar não ressuscita)', () => {
  const p = preload({ stored: { 'duotela-welcome-v4': '1' }, backup: { 'duotela-install-id': 'antigo', 'duotela-welcome-v4': '0' } });
  assert.equal(p.store.has('duotela-install-id'), false, 'a pessoa recusou as estatísticas e o id foi apagado: fica apagado');
  assert.equal(p.store.get('duotela-welcome-v4'), '1');
});

test('envia a cópia só quando algo muda, inclusive remoções, e só chaves do app', () => {
  const p = preload({ stored: { 'duotela-display-name-v1': '"A"', 'chave-estranha': 'x' } });
  p.tick();
  assert.equal(p.sent.length, 0, 'nada mudou desde o início');
  p.store.set('duotela-ptt', '{"on":true}'); p.tick();
  assert.equal(p.sent.length, 1);
  assert.deepEqual(Object.keys(p.sent[0].v).sort(), ['duotela-display-name-v1', 'duotela-ptt']);
  p.tick(); assert.equal(p.sent.length, 1, 'sem mudança, sem envio');
  p.store.delete('duotela-ptt'); p.pagehide();
  assert.equal(p.sent.length, 2);
  assert.deepEqual(Object.keys(p.sent[1].v), ['duotela-display-name-v1'], 'a remoção também é enviada');
});

test('o app usa partição persistente e porta fixa (sem isso nada é lembrado depois de fechar)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /makeView\('persist:duotela-local'/);
  assert.match(main, /session\.fromPartition\('persist:duotela-local'\)/);
  assert.doesNotMatch(main, /fromPartition\('duotela-local-spike'\)/);
  assert.match(main, /startStableServer\(\)/);
  assert.match(main, /PORT: String\(port\)/);
});
