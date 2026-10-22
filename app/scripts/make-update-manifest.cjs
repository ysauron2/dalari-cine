'use strict';
// Gera latest.json (+ latest.json.sig) a partir dos instaladores de uma Release. Roda no GitHub Actions.
//   UPDATE_SIGNING_KEY=<chave privada base64> node scripts/make-update-manifest.cjs <pasta-dos-instaladores> <versão> [pasta-de-saída]
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NAME_RE, verifyManifest } = require('../src/updater.cjs');

const KINDS = [
  [/^DalariCine-Setup-.+-x64\.exe$/, 'win-x64'],
  [/^DalariCine-.+-mac-arm64\.dmg$/, 'mac-arm64'],
  [/^DalariCine-.+-mac-x64\.dmg$/, 'mac-x64']
];

function buildManifest(dir, version) {
  const assets = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const kind = KINDS.find(([re]) => re.test(name));
    if (!kind || !NAME_RE.test(name)) continue;
    const bytes = fs.readFileSync(path.join(dir, name));
    assets[kind[1]] = { name, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  }
  if (!Object.keys(assets).length) throw new Error('nenhum instalador encontrado em ' + dir);
  return Buffer.from(JSON.stringify({ version, assets }, null, 2) + '\n');
}

function signManifest(bytes, privateKeyB64) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, bytes, key).toString('base64');
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  verifyManifest(bytes, sig, pub);                       // confere o que acabou de gerar, do jeito que o app vai conferir
  return sig;
}

if (require.main === module) {
  const [dir, version, out = dir] = process.argv.slice(2);
  if (!dir || !/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('Uso: make-update-manifest.cjs <pasta> <x.y.z> [saída]'); process.exit(2); }
  if (!process.env.UPDATE_SIGNING_KEY) { console.error('UPDATE_SIGNING_KEY ausente: as atualizações automáticas não serão publicadas.'); process.exit(3); }
  const bytes = buildManifest(dir, version);
  const sig = signManifest(bytes, process.env.UPDATE_SIGNING_KEY.trim());
  fs.writeFileSync(path.join(out, 'latest.json'), bytes);
  fs.writeFileSync(path.join(out, 'latest.json.sig'), sig);
  console.log(`latest.json (${version}) e latest.json.sig gerados em ${out}`);
}

module.exports = { buildManifest, signManifest };
