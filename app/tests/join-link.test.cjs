'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeJoinCode, parseJoinUrl, findJoinCode } = require('../src/url-policy.cjs');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('link do convite: só dalari://entrar/XXXX-XXXX, com o código normalizado', () => {
  assert.equal(parseJoinUrl('dalari://entrar/K7QM-93XP'), 'K7QM-93XP');
  assert.equal(parseJoinUrl('dalari://entrar/k7qm93xp'), 'K7QM-93XP', 'minúsculas e sem hífen');
  assert.equal(parseJoinUrl('dalari://entrar/K7QM-93XP/'), 'K7QM-93XP', 'o Windows costuma acrescentar uma barra');
  assert.equal(parseJoinUrl('dalari://entrar/K7QM%2D93XP'), 'K7QM-93XP');
  assert.equal(parseJoinUrl('dalari://entrar/O1L0-IIOO'), '0110-1100', 'O vira 0 e I/L viram 1, como no app');
});

test('link do convite: qualquer outra forma é recusada', () => {
  const bad = [
    'http://entrar/K7QM-93XP', 'https://entrar/K7QM-93XP', 'dalari://outro/K7QM-93XP', 'dalari://entrar', 'dalari://entrar/', 'dalari://entrar/K7QM',
    'dalari://entrar/K7QM-93XPZ', 'dalari://entrar/K7QM-93XU', 'dalari://entrar/K7QM-93XP/extra', 'dalari://entrar/K7QM-93XP?x=1', 'dalari://entrar/K7QM-93XP#frag',
    'dalari://user:pw@entrar/K7QM-93XP', 'dalari://entrar:80/K7QM-93XP', 'dalari://entrar/%00K7QM-93XP', 'dalari://entrar/%E0%A4%A', 'javascript:alert(1)', 'file:///etc/passwd',
    '', 'lixo', null, undefined, 5, {}, [], 'dalari://entrar/' + 'A'.repeat(200),
  ];
  for (const raw of bad) assert.equal(parseJoinUrl(raw), null, String(raw).slice(0, 50));
});

test('código: mesmas regras do código curto do app (alfabeto sem I, L, O, U)', () => {
  assert.equal(normalizeJoinCode(' k7qm 93xp '), 'K7QM-93XP');
  assert.equal(normalizeJoinCode('K7QM-93XU'), null);
  assert.equal(normalizeJoinCode('K7QM'), null); assert.equal(normalizeJoinCode(null), null);
});

test('na linha de comando, o primeiro convite válido; o resto é ignorado', () => {
  assert.equal(findJoinCode(['C:\\app\\DalariCine.exe', '--flag', 'dalari://entrar/K7QM-93XP']), 'K7QM-93XP');
  assert.equal(findJoinCode(['x', 'dalari://outro/K7QM-93XP', 'dalari://entrar/ABCD-EFGH']), 'ABCD-EFGH');
  assert.equal(findJoinCode(['x', 'y']), null); assert.equal(findJoinCode(undefined), null); assert.equal(findJoinCode('dalari://entrar/K7QM-93XP'), null);
});

test('processo principal: uma instância só, links por argumento e por open-url, entrega só à interface do app', () => {
  const main = read('main.cjs');
  assert.match(main, /const gotInstanceLock = app\.requestSingleInstanceLock\(\);\s*if \(!gotInstanceLock\) app\.quit\(\);/);
  assert.match(main, /app\.on\('second-instance', \(_event, argv\) => \{\s*const code = findJoinCode\(argv\);/);
  assert.match(main, /app\.on\('open-url', \(event, url\) => \{[^\n]*\n\s*event\.preventDefault\(\);\s*handleJoinCode\(parseJoinUrl\(url\)\);/);
  assert.match(main, /let pendingJoin = findJoinCode\(process\.argv\);/);
  assert.match(main, /app\.whenReady\(\)\.then\(async \(\) => \{\s*if \(!gotInstanceLock\) return;/);
  assert.match(main, /if \(app\.isPackaged\) app\.setAsDefaultProtocolClient\('dalari'\);/, 'só no app instalado');
  assert.match(main, /const acceptJoinReady = event => \{ if \(fromDuo\(event\)\) \{ joinReady = true; flushJoin\(\); \} \};/);
  assert.match(main, /ipcMain\.removeListener\('duotela:join-ready', acceptJoinReady\);/);
  assert.match(main, /duoView\.webContents\.send\('duotela:join-link', pendingJoin\)/);
});

test('preload: entrega só códigos no formato certo e avisa que a interface está pronta', () => {
  const pre = read('src', 'duotela-preload.cjs');
  assert.match(pre, /onJoinLink: callback => \{/);
  assert.match(pre, /\/\^\[0-9A-Z\]\{4\}-\[0-9A-Z\]\{4\}\$\/\.test\(code\)/);
  assert.match(pre, /ipcRenderer\.send\('duotela:join-ready'\)/);
});

test('instaladores: o Windows registra dalari:// só para o usuário (e remove ao desinstalar); o Mac declara o esquema no Info.plist', () => {
  const nsi = read('installer.nsi');
  assert.match(nsi, /WriteRegStr HKCU "Software\\Classes\\dalari" "URL Protocol" ""/);
  assert.match(nsi, /WriteRegStr HKCU "Software\\Classes\\dalari\\shell\\open\\command" "" '"\$INSTDIR\\DalariCine\.exe" "%1"'/);
  assert.match(nsi, /DeleteRegKey HKCU "Software\\Classes\\dalari"/);
  assert.doesNotMatch(nsi, /HKLM|HKCR/, 'nada em áreas que exigem administrador');
  const mac = read('scripts', 'build-macos-app.sh');
  assert.match(mac, /CFBundleURLTypes:0:CFBundleURLSchemes:0 string dalari/);
  assert.match(mac, /CFBundleURLName string br\.dalari\.cine/);
});

test('macOS: o app declara por que usa a rede local (permissão do sistema para a conexão direta na mesma casa)', () => {
  const mac = read('scripts', 'build-macos-app.sh');
  assert.match(mac, /Add :NSLocalNetworkUsageDescription string '/);
  assert.match(mac, /Delete :NSLocalNetworkUsageDescription/);
});
