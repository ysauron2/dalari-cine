'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildManifest, signManifest } = require('../scripts/make-update-manifest.cjs');
const { stamp } = require('../scripts/stamp-build.cjs');
const { verifyManifest, readConfig } = require('../src/updater.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dalari-man-'));

test('o manifesto gerado no CI é aceito pelo verificador do app, com a chave pública correspondente', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'DalariCine-Setup-0.2.0-x64.exe'), 'win');
    fs.writeFileSync(path.join(dir, 'DalariCine-0.2.0-mac-arm64.dmg'), 'arm');
    fs.writeFileSync(path.join(dir, 'DalariCine-0.2.0-mac-x64.dmg'), 'x64');
    fs.writeFileSync(path.join(dir, 'outro-arquivo.zip'), 'ignorado');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const bytes = buildManifest(dir, '0.2.0');
    const sig = signManifest(bytes, privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
    const m = verifyManifest(bytes, sig, publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
    assert.deepEqual(Object.keys(m.assets).sort(), ['mac-arm64', 'mac-x64', 'win-x64']);
    assert.equal(m.assets['win-x64'].sha256, crypto.createHash('sha256').update('win').digest('hex'));
    assert.equal(m.assets['win-x64'].size, 3);
    assert.ok(readConfig({ repo: 'dalari/cine', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }), 'a chave que o script de chaves imprime é aceita pela configuração');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sem instaladores ou com chave errada o CI falha em vez de publicar algo inválido', () => {
  const dir = tmp();
  try {
    assert.throws(() => buildManifest(dir, '0.2.0'), /nenhum instalador/);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-update-manifest.cjs'), dir, '0.2.0'], { env: { ...process.env, UPDATE_SIGNING_KEY: '' }, encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /UPDATE_SIGNING_KEY/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stamp-build carimba versão e repositório sem sobrescrever um repositório já configurado', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }));
    fs.writeFileSync(path.join(dir, 'update-config.json'), JSON.stringify({ repo: '', publicKey: 'K' }));
    stamp(dir, { version: '1.2.3', repo: 'dono/app' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.2.3');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'update-config.json'), 'utf8')), { repo: 'dono/app', publicKey: 'K' });
    stamp(dir, { version: '0.0.0-dev', repo: 'outro/repo' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.0.0-dev');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'update-config.json'), 'utf8')).repo, 'dono/app');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
