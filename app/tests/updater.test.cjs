'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../src/updater.cjs');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const CONFIG = { repo: 'dalari/cine', publicKey: PUB };
const INSTALLER = Buffer.from('instalador de mentira '.repeat(500));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifestFor = (version, over = {}) => Buffer.from(JSON.stringify({
  version, assets: { 'win-x64': { name: `DalariCine-Setup-${version}-x64.exe`, sha256: sha(INSTALLER), size: INSTALLER.length, ...over }, 'mac-arm64': { name: `DalariCine-${version}-mac-arm64.dmg`, sha256: sha(INSTALLER), size: INSTALLER.length } }
}));
const sign = (bytes, key = privateKey) => crypto.sign(null, bytes, key).toString('base64');

// fetch de mentira: mapa url -> Buffer | {status}
function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return new Response('', { status: 404 });
    if (r.status) return new Response('', { status: r.status });
    const res = new Response(r);
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
}
function releaseRoutes(version, { manifest = manifestFor(version), sig } = {}) {
  return {
    [U.manifestUrl('dalari/cine')]: manifest,
    [U.signatureUrl('dalari/cine')]: Buffer.from(sig ?? sign(manifest)),
    [U.assetUrl('dalari/cine', version, `DalariCine-Setup-${version}-x64.exe`)]: INSTALLER
  };
}
const base = { config: CONFIG, current: '0.1.0', platform: 'win32', arch: 'x64' };

test('compara versões e ignora versões de desenvolvimento', () => {
  assert.equal(U.isNewer('0.2.0', '0.1.9'), true);
  assert.equal(U.isNewer('1.0.0', '0.99.99'), true);
  assert.equal(U.isNewer('0.1.0', '0.1.0'), false);
  assert.equal(U.isNewer('0.1.0', '0.2.0'), false);
  assert.equal(U.isNewer('0.2.0', '0.0.0-dev'), false);
  assert.equal(U.isNewer('0.2.0-beta', '0.1.0'), false);
  assert.equal(U.platformKey('win32', 'x64'), 'win-x64');
  assert.equal(U.platformKey('darwin', 'arm64'), 'mac-arm64');
  assert.equal(U.platformKey('linux', 'x64'), null);
});

test('sem repositório ou chave válida, nada é consultado', async () => {
  const calls = [];
  for (const config of [null, {}, { repo: 'dalari/cine' }, { repo: 'dalari/cine', publicKey: 'xx' }, { repo: '../x', publicKey: PUB }, { repo: 'a/..', publicKey: PUB }, { repo: 'a/b/c', publicKey: PUB }]) {
    const r = await U.checkForUpdate({ ...base, config, fetch: fakeFetch({}, calls) });
    assert.equal(r.status, 'disabled');
  }
  assert.equal((await U.checkForUpdate({ ...base, current: '0.0.0-dev', fetch: fakeFetch({}, calls) })).status, 'disabled');
  assert.equal((await U.checkForUpdate({ ...base, platform: 'linux', fetch: fakeFetch({}, calls) })).status, 'disabled');
  assert.deepEqual(calls, []);
});

test('versão nova assinada aparece como disponível, com link montado pelo app', async () => {
  const r = await U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0')) });
  assert.equal(r.status, 'available');
  assert.equal(r.version, '0.2.0');
  assert.equal(r.asset.url, 'https://github.com/dalari/cine/releases/download/v0.2.0/DalariCine-Setup-0.2.0-x64.exe');
});

test('mesma versão, versão antiga ou sem Release: nada a fazer', async () => {
  assert.equal((await U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.1.0')) })).status, 'current');
  assert.equal((await U.checkForUpdate({ ...base, current: '0.3.0', fetch: fakeFetch(releaseRoutes('0.2.0')) })).status, 'current');
  assert.equal((await U.checkForUpdate({ ...base, fetch: fakeFetch({}) })).status, 'current');
});

test('manifesto adulterado, assinado por outra chave ou sem assinatura é recusado', async () => {
  const m = manifestFor('0.2.0');
  const tampered = Buffer.from(m.toString().replace('0.2.0', '9.9.9'));
  await assert.rejects(U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0', { manifest: tampered, sig: sign(m) })) }), /assinatura/);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  await assert.rejects(U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0', { sig: sign(m, other) })) }), /assinatura/);
  const routes = releaseRoutes('0.2.0'); delete routes[U.signatureUrl('dalari/cine')];
  await assert.rejects(U.checkForUpdate({ ...base, fetch: fakeFetch(routes) }), /ausente/);
  await assert.rejects(U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0', { sig: '%%%' })) }), /assinatura/);
});

test('o manifesto não consegue apontar para outro endereço nem nome de arquivo estranho', async () => {
  for (const name of ['../evil.exe', 'evil.exe', 'DalariCine-x.sh', 'DalariCine-/../x.exe', 'DalariCine-x.exe?y=1']) {
    const m = manifestFor('0.2.0', { name });
    await assert.rejects(U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0', { manifest: m })) }), /inválido/);
  }
  await assert.rejects(U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0', { manifest: manifestFor('0.2.0', { sha256: 'abc' }) })) }), /inválido/);
  await assert.rejects(U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0', { manifest: manifestFor('0.2.0', { size: 10 ** 10 }) })) }), /inválido/);
});

test('download íntegro é gravado; hash, tamanho ou HTTP errado são recusados e não deixam arquivo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalari-upd-'));
  try {
    const r = await U.checkForUpdate({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0')) });
    const seen = [];
    const file = await U.downloadAsset({ asset: r.asset, destDir: dir, fetch: fakeFetch(releaseRoutes('0.2.0')), onProgress: (p) => seen.push(p) });
    assert.deepEqual(fs.readFileSync(file), INSTALLER);
    assert.equal(seen.at(-1), 1);

    const bad = Buffer.concat([INSTALLER.subarray(0, INSTALLER.length - 1), Buffer.from('X')]);
    const routes = { [r.asset.url]: bad };
    fs.rmSync(file);
    await assert.rejects(U.downloadAsset({ asset: r.asset, destDir: dir, fetch: fakeFetch(routes) }), /não confere/);
    await assert.rejects(U.downloadAsset({ asset: r.asset, destDir: dir, fetch: fakeFetch({ [r.asset.url]: INSTALLER.subarray(0, 100) }) }), /incompleto/);
    await assert.rejects(U.downloadAsset({ asset: r.asset, destDir: dir, fetch: fakeFetch({ [r.asset.url]: Buffer.concat([INSTALLER, INSTALLER]) }) }), /maior/);
    await assert.rejects(U.downloadAsset({ asset: r.asset, destDir: dir, fetch: fakeFetch({ [r.asset.url]: { status: 500 } }) }), /500/);
    await assert.rejects(U.downloadAsset({ asset: { ...r.asset, url: 'https://evil.example/x.exe' }, destDir: dir, fetch: fakeFetch({}) }), /inválido/);
    assert.deepEqual(fs.readdirSync(dir), [], 'nenhum arquivo parcial ou corrompido fica no disco');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalari-upd-'));
  const events = [], launched = [], settings = new Map(), quits = [];
  const u = U.createUpdater({
    ...base, tmpDir: dir, fetch: fakeFetch(releaseRoutes('0.2.0')),
    launchInstaller: async (f) => { launched.push(f); return { quit: true }; },
    quit: () => quits.push(1), emit: (s) => events.push(s), store: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) },
    ...over
  });
  return { u, events, launched, quits, settings, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('verificação automática avisa sem baixar; instalar baixa, abre o instalador e fecha o app', async () => {
  const t = rig();
  try {
    await t.u.check();
    assert.equal(t.u.getState().status, 'available');
    assert.equal(t.u.getState().version, '0.2.0');
    assert.equal(t.launched.length, 0, 'não baixa nem instala sozinho');
    await t.u.install();
    assert.equal(t.launched.length, 1);
    assert.match(path.basename(t.launched[0]), /^DalariCine-Setup-0\.2\.0-x64\.exe$/);
    assert.deepEqual(fs.readFileSync(t.launched[0]), INSTALLER);
    assert.equal(t.quits.length, 1);
    assert.equal(t.u.getState().status, 'installing');
  } finally { t.done(); }
});

test('no Mac o instalador é só aberto: o app não fecha e pede para arrastar', async () => {
  const t = rig({ platform: 'darwin', arch: 'arm64', fetch: fakeFetch({ ...releaseRoutes('0.2.0'), [U.assetUrl('dalari/cine', '0.2.0', 'DalariCine-0.2.0-mac-arm64.dmg')]: INSTALLER }), launchInstaller: async () => ({ quit: false }) });
  try {
    await t.u.check(); await t.u.install();
    assert.equal(t.u.getState().status, 'ready');
    assert.match(t.u.getState().message, /Aplicativos/);
    assert.equal(t.quits.length, 0);
  } finally { t.done(); }
});

test('erro de rede é silencioso no automático e visível no manual; arquivo corrompido não instala', async () => {
  const t = rig({ fetch: async () => { throw new Error('ENOTFOUND github.com'); } });
  try {
    await t.u.check();
    assert.notEqual(t.u.getState().status, 'error');
    await t.u.check({ manual: true });
    assert.equal(t.u.getState().status, 'error');
    assert.match(t.u.getState().message, /verificar/);
  } finally { t.done(); }
  const routes = releaseRoutes('0.2.0');
  routes[U.assetUrl('dalari/cine', '0.2.0', 'DalariCine-Setup-0.2.0-x64.exe')] = Buffer.alloc(INSTALLER.length, 1);
  const c = rig({ fetch: fakeFetch(routes) });
  try {
    await c.u.check(); await c.u.install();
    assert.equal(c.u.getState().status, 'error');
    assert.equal(c.launched.length, 0, 'instalador corrompido nunca é executado');
    assert.equal(c.quits.length, 0);
  } finally { c.done(); }
});

test('auto desligado: o relógio não consulta; estado só expõe campos simples', async () => {
  const t = rig();
  try {
    t.u.setAuto(false);
    assert.equal(t.u.getState().auto, false);
    let fired = null; const timers = [];
    const calls = [];
    const u2 = U.createUpdater({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0'), calls), tmpDir: t.dir, launchInstaller: async () => ({}), quit() {}, emit() {}, store: { get: () => false, set() {} }, setTimer: (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; }, clearTimer() {} });
    u2.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0][1], U.CHECK_FIRST_MS);
    await timers[0][0]();
    assert.deepEqual(calls, [], 'com a opção desligada, nenhuma consulta é feita');
    assert.equal(timers.length, 2, 'agenda a próxima verificação');
    assert.deepEqual(Object.keys(u2.getState()).sort(), ['auto', 'current', 'enabled', 'manual', 'message', 'progress', 'required', 'status', 'version']);
    void fired;
  } finally { t.done(); }
});

// ---- versão mínima ----
const manifestMin = (version, min) => Buffer.from(JSON.stringify({ version, minVersion: min, assets: { 'win-x64': { name: `DalariCine-Setup-${version}-x64.exe`, sha256: sha(INSTALLER), size: INSTALLER.length } } }));

test('versão mínima: abaixo dela vira "obrigatória"; na versão certa ou acima não; sem o campo, nunca', async () => {
  const routes = (min, version = '0.2.0') => releaseRoutes(version, { manifest: manifestMin(version, min), sig: sign(manifestMin(version, min)) });
  assert.equal((await U.checkForUpdate({ ...base, current: '0.1.0', fetch: fakeFetch(routes('0.2.0')) })).required, true);
  assert.equal((await U.checkForUpdate({ ...base, current: '0.2.0', fetch: fakeFetch(routes('0.2.0')) })).required, false);
  assert.equal((await U.checkForUpdate({ ...base, current: '0.3.0', fetch: fakeFetch(routes('0.2.0')) })).required, false);
  assert.equal((await U.checkForUpdate({ ...base, current: '0.1.0', fetch: fakeFetch(releaseRoutes('0.2.0')) })).required, false, 'manifesto sem o campo');
});

test('versão mínima: o app consulta mesmo com a atualização automática desligada, e sem rede nunca bloqueia', async () => {
  const man = manifestMin('0.2.0', '0.2.0');
  const t = rig({ store: { get: () => false, set() {} }, fetch: fakeFetch(releaseRoutes('0.2.0', { manifest: man, sig: sign(man) })) });
  try {
    const r = await t.u.requirement();
    assert.equal(r.required, true);
    assert.equal(t.u.getState().required, true);
    assert.equal(t.u.getState().status, 'available', 'obrigatória: oferece instalar mesmo com a automática desligada');
  } finally { t.done(); }
  const ok = rig({ current: '0.2.0', fetch: fakeFetch(releaseRoutes('0.2.0', { manifest: man, sig: sign(man) })) });
  try { assert.equal((await ok.u.requirement()).required, false); } finally { ok.done(); }
  const offline = rig({ fetch: async () => { throw new Error('ENOTFOUND github.com'); } });
  try { assert.equal((await offline.u.requirement()).required, false, 'sem internet: não tranca o app'); } finally { offline.done(); }
  const off = rig({ config: null });
  try { assert.equal((await off.u.requirement()).required, false); } finally { off.done(); }
  // a automática desligada com versão mínima já atendida: não aparece aviso de nova versão
  const quiet = rig({ current: '0.2.0', store: { get: () => false, set() {} }, fetch: fakeFetch(releaseRoutes('0.3.0', { manifest: manifestMin('0.3.0', '0.2.0'), sig: sign(manifestMin('0.3.0', '0.2.0')) })) });
  try { await quiet.u.requirement(); assert.notEqual(quiet.u.getState().status, 'available'); } finally { quiet.done(); }
});

test('versão mínima: com a automática ligada o relógio já marca a versão obrigatória; desligada, só a consulta explícita (criar/entrar em sala) vai à rede', async () => {
  const man = manifestMin('0.2.0', '0.2.0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalari-upd-'));
  try {
    const make = (autoOn, calls) => { const timers = []; const u = U.createUpdater({ ...base, fetch: fakeFetch(releaseRoutes('0.2.0', { manifest: man, sig: sign(man) }), calls), tmpDir: dir, launchInstaller: async () => ({}), quit() {}, emit() {}, store: { get: () => autoOn, set() {} }, setTimer: (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; }, clearTimer() {} }); u.start(); return { u, timers }; };
    const onCalls = [], on = make(true, onCalls);
    await on.timers[0][0]();
    assert.ok(onCalls.length >= 1); assert.equal(on.u.getState().required, true);
    const offCalls = [], off = make(false, offCalls);
    await off.timers[0][0]();
    assert.deepEqual(offCalls, [], 'automática desligada: o relógio não consulta');
    await off.u.requirement();
    assert.ok(offCalls.length >= 1, 'a consulta explícita consulta'); assert.equal(off.u.getState().required, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
