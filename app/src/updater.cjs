'use strict';
// Atualização automática a partir das Releases do GitHub.
// Segurança: o instalador não tem assinatura da Microsoft/Apple, então a confiança vem de uma chave Ed25519 nossa:
// latest.json é assinado no GitHub Actions (segredo UPDATE_SIGNING_KEY) e o app só aceita se a assinatura bater com a
// chave pública embutida (update-config.json). O manifesto traz o SHA-256 de cada instalador; o link de download é
// montado pelo próprio app (repositório + versão + nome validado), nunca vem do manifesto.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const NAME_RE = /^DalariCine-[A-Za-z0-9._-]{1,100}\.(exe|dmg)$/;
const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;   // sem "." / ".." (nada de sair do caminho)
const PLATFORM_KEYS = new Set(['win-x64', 'mac-arm64', 'mac-x64']);
const MAX_MANIFEST = 64 * 1024;
const MAX_INSTALLER = 600 * 1024 * 1024;
const CHECK_FIRST_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function parseVersion(v) {
  const m = VERSION_RE.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function platformKey(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  return null;
}
const releaseBase = (repo) => `https://github.com/${repo}/releases`;
const manifestUrl = (repo) => `${releaseBase(repo)}/latest/download/latest.json`;
const signatureUrl = (repo) => `${releaseBase(repo)}/latest/download/latest.json.sig`;
const assetUrl = (repo, version, name) => `${releaseBase(repo)}/download/v${version}/${name}`;

// Devolve null quando o recurso não está configurado (sem repositório ou chave): então nada é consultado.
function readConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
  const key = typeof raw.publicKey === 'string' ? raw.publicKey.trim() : '';
  if (!REPO_RE.test(repo) || !/^[A-Za-z0-9+/=]{40,200}$/.test(key)) return null;
  try { crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }); } catch { return null; }
  return { repo, publicKey: key };
}

function verifyManifest(bytes, signatureB64, publicKeyB64) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MANIFEST) throw new Error('manifesto inválido');
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    ok = crypto.verify(null, bytes, key, Buffer.from(String(signatureB64).trim(), 'base64'));
  } catch { ok = false; }
  if (!ok) throw new Error('assinatura da atualização não confere');
  let m;
  try { m = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('manifesto ilegível'); }
  if (!m || typeof m !== 'object' || !parseVersion(m.version) || !m.assets || typeof m.assets !== 'object') throw new Error('manifesto incompleto');
  const assets = {};
  for (const [key, a] of Object.entries(m.assets)) {
    if (!PLATFORM_KEYS.has(key)) continue;
    if (!a || typeof a.name !== 'string' || !NAME_RE.test(a.name) || typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)
      || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_INSTALLER) throw new Error('manifesto com arquivo inválido');
    assets[key] = { name: a.name, sha256: a.sha256, size: a.size };
  }
  // minVersion (opcional, assinado junto): abaixo dela o app não cria nem entra em salas até atualizar
  return { version: m.version, minVersion: parseVersion(m.minVersion) ? m.minVersion : null, assets };
}

async function readLimited(res, limit) {
  const chunks = []; let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > limit) throw new Error('resposta grande demais');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}
async function getBytes(fetchImpl, url, limit) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'DalariCine-updater' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`servidor respondeu ${res.status}`);
  if (res.url && !String(res.url).startsWith('https://')) throw new Error('resposta fora de HTTPS');
  return readLimited(res, limit);
}

// Consulta a última Release. Resultado: {status:'disabled'|'current'|'available', ...}. Erros de rede viram exceção.
async function checkForUpdate({ config, current, platform, arch, fetch: fetchImpl = globalThis.fetch }) {
  const cfg = readConfig(config);
  if (!cfg) return { status: 'disabled', reason: 'not-configured' };
  if (!parseVersion(current)) return { status: 'disabled', reason: 'dev-build' };
  const key = platformKey(platform, arch);
  if (!key) return { status: 'disabled', reason: 'unsupported' };
  const manifestBytes = await getBytes(fetchImpl, manifestUrl(cfg.repo), MAX_MANIFEST);
  if (!manifestBytes) return { status: 'current' };                       // sem Release publicada (ou repositório privado)
  const sig = await getBytes(fetchImpl, signatureUrl(cfg.repo), 4096);
  if (!sig) throw new Error('assinatura da atualização ausente');
  const manifest = verifyManifest(manifestBytes, sig.toString('utf8'), cfg.publicKey);
  const required = !!manifest.minVersion && isNewer(manifest.minVersion, current);
  if (!isNewer(manifest.version, current)) return { status: 'current', required };
  const asset = manifest.assets[key];
  if (!asset) return { status: 'current', required };                      // esta versão não tem pacote para este sistema
  return { status: 'available', required, minVersion: manifest.minVersion, version: manifest.version, asset: { ...asset, url: assetUrl(cfg.repo, manifest.version, asset.name) } };
}

// Baixa para destDir, conferindo tamanho e SHA-256; só devolve o caminho de um arquivo íntegro.
async function downloadAsset({ asset, destDir, fetch: fetchImpl = globalThis.fetch, onProgress }) {
  if (!asset || !NAME_RE.test(asset.name) || !String(asset.url).startsWith('https://github.com/')) throw new Error('arquivo de atualização inválido');
  await fs.promises.mkdir(destDir, { recursive: true });
  const final = path.join(destDir, asset.name), part = final + '.part';
  const res = await fetchImpl(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000), headers: { 'user-agent': 'DalariCine-updater' } });
  if (!res.ok) throw new Error(`servidor respondeu ${res.status}`);
  if (res.url && !String(res.url).startsWith('https://')) throw new Error('download fora de HTTPS');
  const hash = crypto.createHash('sha256'); let size = 0, lastTick = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > asset.size) return cb(new Error('arquivo maior que o esperado'));
      hash.update(chunk);
      const now = Date.now();
      if (onProgress && now - lastTick > 250) { lastTick = now; onProgress(Math.min(1, size / asset.size)); }
      cb(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb ? Readable.fromWeb(res.body) : Readable.from(res.body), meter, fs.createWriteStream(part, { mode: 0o600 }));
    if (size !== asset.size) throw new Error('arquivo incompleto');
    if (hash.digest('hex') !== asset.sha256) throw new Error('o arquivo baixado não confere com o esperado');
    await fs.promises.rename(part, final);
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw e;
  }
  onProgress?.(1);
  return final;
}

const SAFE_MESSAGE = /[^\p{L}\p{N} .,:;()\-–/]/gu;
const brief = (e) => String(e?.message || e || 'erro').replace(SAFE_MESSAGE, ' ').slice(0, 160);

// Máquina de estados da atualização. As dependências (rede, disco, instalar, sair) entram por parâmetro para testar.
function createUpdater({ config, current, platform, arch, fetch: fetchImpl, tmpDir, launchInstaller, quit, emit, store, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = { status: 'idle', version: null, progress: 0, message: '', manual: false, required: false };
  let pending = null, timer = null, busy = false;
  const auto = () => store.get('auto') !== false;
  const publish = (patch) => { state = { ...state, ...patch }; emit(snapshot()); };
  const snapshot = () => ({ status: state.status, version: state.version, progress: state.progress, message: state.message, manual: state.manual, required: state.required === true, auto: auto(), current: parseVersion(current) ? current : '', enabled: !!readConfig(config) && !!parseVersion(current) && !!platformKey(platform, arch) });

  // "Versão mínima": consulta o manifesto mesmo com a atualização automática desligada. Sem rede ou sem manifesto, não bloqueia nada.
  async function requirement() {
    if (!snapshot().enabled) return { required: false };
    if (!busy && state.status !== 'downloading' && state.status !== 'installing') {
      busy = true;
      try {
        const r = await checkForUpdate({ config, current, platform, arch, fetch: fetchImpl });
        const required = r.required === true;
        if (r.status === 'available' && (required || auto())) { pending = r; publish({ status: 'available', version: r.version, message: '', progress: 0, required }); }
        else if (required !== state.required) publish({ required });
      } catch { /* sem rede: mantém o que já sabia */ } finally { busy = false; }
    }
    return { required: state.required === true, current: parseVersion(current) ? current : '', status: state.status, version: state.version };
  }

  async function check({ manual = false } = {}) {
    if (busy || state.status === 'downloading' || state.status === 'installing') return snapshot();
    busy = true;
    if (manual) publish({ status: 'checking', message: '' });
    try {
      const r = await checkForUpdate({ config, current, platform, arch, fetch: fetchImpl });
      if ((r.required === true) !== state.required) publish({ required: r.required === true });
      if (r.status === 'available') { pending = r; publish({ status: 'available', version: r.version, message: '', progress: 0 }); }
      else if (manual) publish({ status: r.status === 'disabled' ? 'disabled' : 'current', message: '' });
      else if (state.status === 'checking') publish({ status: 'idle' });
    } catch (e) {
      if (manual) publish({ status: 'error', message: 'Não foi possível verificar: ' + brief(e) });
    } finally { busy = false; }
    return snapshot();
  }

  async function install() {
    if (state.status !== 'available' || !pending || busy) return snapshot();
    busy = true;
    const { asset, version } = pending;
    publish({ status: 'downloading', progress: 0, message: '' });
    try {
      const file = await downloadAsset({ asset, destDir: path.join(tmpDir, 'DalariCine-update-' + version), fetch: fetchImpl, onProgress: (p) => publish({ progress: p }) });
      const r = await launchInstaller(file);
      if (r?.quit) { publish({ status: 'installing', progress: 1 }); quit(); }
      else publish({ status: 'ready', progress: 1, manual: true, message: 'Instalador aberto: arraste o Dalari Cine para Aplicativos e substitua o antigo.' });
    } catch (e) {
      publish({ status: 'error', message: 'Falha ao atualizar: ' + brief(e) });
    } finally { busy = false; }
    return snapshot();
  }

  function schedule(ms) {
    timer = setTimer(async () => {
      if (auto()) await check();      // desligada: nenhuma consulta em segundo plano (a versão mínima só é checada ao criar ou entrar em sala)
      schedule(CHECK_EVERY_MS);
    }, ms);
    timer?.unref?.();
  }
  function start() { if (!timer && snapshot().enabled) schedule(CHECK_FIRST_MS); }
  function stop() { if (timer) clearTimer(timer); timer = null; }
  function setAuto(on) { store.set('auto', on === true); publish({}); }
  return { check, install, start, stop, setAuto, requirement, getState: snapshot };
}

module.exports = { parseVersion, isNewer, platformKey, readConfig, verifyManifest, manifestUrl, signatureUrl, assetUrl, checkForUpdate, downloadAsset, createUpdater, NAME_RE, CHECK_FIRST_MS, CHECK_EVERY_MS };
