'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isInsideAppBundle, resolveProfileDir, readDuoTelaUrlSetting, readAllowLanSetting, readAllowRemoteSetting } = require('../src/runtime-paths.cjs');

test('LAN: ambiente ou duotela-allow-lan.txt com "1"; qualquer outra coisa ou ausência = desligado', () => {
  const file = content => f => { assert.equal(path.basename(f), 'duotela-allow-lan.txt'); return content; };
  assert.equal(readAllowLanSetting({ env: { DUOTELA_ALLOW_LAN: '1' }, profileDir: '/p', readFile: () => { throw new Error('não deveria ler'); } }), true);
  assert.equal(readAllowLanSetting({ env: { DUOTELA_ALLOW_LAN: '0' }, profileDir: '/p', readFile: file('1') }), false);
  assert.equal(readAllowLanSetting({ env: {}, profileDir: '/p', readFile: file('1\n') }), true);
  assert.equal(readAllowLanSetting({ env: {}, profileDir: '/p', readFile: file('true') }), false);
  assert.equal(readAllowLanSetting({ env: {}, profileDir: '/p', readFile: () => { throw new Error('ENOENT'); } }), false);
});

test('detecta execução dentro de um .app e fora dele', () => {
  assert.equal(isInsideAppBundle('/Users/a/dist-macos/Dalari Cine.app/Contents/Resources/app'), true);
  assert.equal(isInsideAppBundle(['C:', 'x', 'Foo.app', 'Contents', 'Resources', 'app'].join(String.fromCharCode(92))), true);
  assert.equal(isInsideAppBundle('/Users/a/work/duotela-ecs-spike'), false);
  assert.equal(isInsideAppBundle('/Users/a/Foo.app.d/Contents/Resources/app'), false);
});

test('perfil do bundle vai para Application Support; desenvolvimento mantém .runtime-profile', () => {
  const base = { env: {}, appDataDir: '/Users/a/Library/Application Support', devDir: '/dev/.runtime-profile' };
  const packaged = resolveProfileDir({ ...base, bundleDir: '/A/Dalari Cine.app/Contents/Resources/app' });
  assert.equal(packaged, path.join('/Users/a/Library/Application Support', 'Dalari Cine'));
  assert.equal(resolveProfileDir({ ...base, bundleDir: '/dev' }), '/dev/.runtime-profile');
});

test('app empacotado no Windows também guarda o perfil em AppData, fora da pasta de instalação', () => {
  const base = { env: {}, appDataDir: 'C:/Users/a/AppData/Roaming', devDir: '/dev/.runtime-profile', bundleDir: 'C:/Users/a/AppData/Local/Programs/DalariCine/resources/app' };
  assert.equal(resolveProfileDir({ ...base, packaged: true }), path.join('C:/Users/a/AppData/Roaming', 'Dalari Cine'));
  assert.equal(resolveProfileDir({ ...base, packaged: false }), '/dev/.runtime-profile');
});

test('DUOTELA_PROFILE_DIR exige caminho absoluto', () => {
  const base = { appDataDir: '/ad', devDir: '/d', bundleDir: '/d' };
  const abs = path.resolve('/tmp/perfil');
  assert.equal(resolveProfileDir({ ...base, env: { DUOTELA_PROFILE_DIR: abs } }), abs);
  assert.throws(() => resolveProfileDir({ ...base, env: { DUOTELA_PROFILE_DIR: 'relativo' } }));
});

test('remoto: DUOTELA_ALLOW_REMOTE ou duotela-allow-remote.txt com "1"; LAN e remoto são independentes', () => {
  const only = name => f => { if (path.basename(f) !== name) throw new Error('ENOENT'); return '1'; };
  assert.equal(readAllowRemoteSetting({ env: { DUOTELA_ALLOW_REMOTE: '1' }, profileDir: '/p', readFile: () => { throw new Error('x'); } }), true);
  assert.equal(readAllowRemoteSetting({ env: {}, profileDir: '/p', readFile: only('duotela-allow-remote.txt') }), true);
  assert.equal(readAllowRemoteSetting({ env: {}, profileDir: '/p', readFile: only('duotela-allow-lan.txt') }), false);
  assert.equal(readAllowLanSetting({ env: {}, profileDir: '/p', readFile: only('duotela-allow-remote.txt') }), false);
});

test('URL vem do ambiente ou do arquivo no perfil; ausência retorna undefined', () => {
  const readFile = file => { assert.equal(path.basename(file), 'duotela-url.txt'); return 'http://127.0.0.1:8787/\n'; };
  assert.equal(readDuoTelaUrlSetting({ env: { DUOTELA_URL: 'http://localhost:1/' }, profileDir: '/p', readFile }), 'http://localhost:1/');
  assert.equal(readDuoTelaUrlSetting({ env: {}, profileDir: '/p', readFile }), 'http://127.0.0.1:8787/');
  assert.equal(readDuoTelaUrlSetting({ env: {}, profileDir: '/p', readFile: () => { throw new Error('ENOENT'); } }), undefined);
});

test('migração da pasta de dados antiga: renomeia só quando a nova não existe; nunca mexe em perfil personalizado', () => {
  const { migrateLegacyProfile } = require('../src/runtime-paths.cjs');
  const appData = path.join('/Users/a/AppData/Roaming');
  const newDir = path.join(appData, 'Dalari Cine'), oldDir = path.join(appData, 'DuoTela Teste');
  const fakeFs = (existing) => { const calls = []; return { calls, existsSync: (p) => existing.has(p), renameSync: (a, b) => { calls.push([a, b]); } }; };
  let fs1 = fakeFs(new Set([oldDir]));
  assert.equal(migrateLegacyProfile({ appDataDir: appData, profileDir: newDir, fs: fs1 }), 'migrated');
  assert.deepEqual(fs1.calls, [[oldDir, newDir]]);
  fs1 = fakeFs(new Set([oldDir, newDir]));                                   // nova já existe: não sobrescreve
  assert.equal(migrateLegacyProfile({ appDataDir: appData, profileDir: newDir, fs: fs1 }), 'none'); assert.equal(fs1.calls.length, 0);
  fs1 = fakeFs(new Set());                                                   // nada a migrar
  assert.equal(migrateLegacyProfile({ appDataDir: appData, profileDir: newDir, fs: fs1 }), 'none');
  fs1 = fakeFs(new Set([oldDir]));                                           // perfil de desenvolvimento ou escolhido pelo usuário
  assert.equal(migrateLegacyProfile({ appDataDir: appData, profileDir: '/dev/.runtime-profile', fs: fs1 }), 'skipped');
  assert.equal(migrateLegacyProfile({ appDataDir: appData, profileDir: path.join('/outro', 'Dalari Cine'), fs: fs1 }), 'skipped');
  assert.equal(fs1.calls.length, 0);
  const failing = { existsSync: (p) => p === oldDir, renameSync: () => { throw new Error('EBUSY'); } };
  assert.equal(migrateLegacyProfile({ appDataDir: appData, profileDir: newDir, fs: failing }), 'failed');   // não derruba o app
});
