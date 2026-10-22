'use strict';

const path = require('node:path');

const BUNDLE_MARKER = /\.app[\\/]Contents[\\/]Resources[\\/]/;
const PROFILE_NAME = 'Dalari Cine';
const LEGACY_PROFILE_NAME = 'DuoTela Teste';   // nome da pasta de dados nas versões de teste anteriores ao Dalari Cine
const URL_FILE = 'duotela-url.txt';
const LAN_FILE = 'duotela-allow-lan.txt';
const REMOTE_FILE = 'duotela-allow-remote.txt';

function isInsideAppBundle(dir) {
  return BUNDLE_MARKER.test(dir + path.sep);
}

// Instalado (app empacotado ou .app) o perfil, com a sessão Netflix, fica no diretório do usuário, nunca na pasta do programa.
function resolveProfileDir({ env, bundleDir, appDataDir, devDir, packaged = false }) {
  const override = env.DUOTELA_PROFILE_DIR;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('DUOTELA_PROFILE_DIR deve ser um caminho absoluto.');
    return override;
  }
  return packaged || isInsideAppBundle(bundleDir) ? path.join(appDataDir, PROFILE_NAME) : devDir;
}

// Quem já testou uma versão anterior mantém nome, preferências e a sessão da Netflix: a pasta antiga é renomeada na primeira
// abertura, só se a nova ainda não existir. Devolve 'migrated' | 'none' | 'skipped' | 'failed'.
function migrateLegacyProfile({ appDataDir, profileDir, fs }) {
  if (path.basename(profileDir) !== PROFILE_NAME || path.dirname(profileDir) !== appDataDir) return 'skipped';   // perfil personalizado ou de desenvolvimento
  const legacy = path.join(appDataDir, LEGACY_PROFILE_NAME);
  try {
    if (!fs.existsSync(legacy) || fs.existsSync(profileDir)) return 'none';
    fs.renameSync(legacy, profileDir);
    return 'migrated';
  } catch { return 'failed'; }
}

// DUOTELA_URL tem prioridade; sem ela, o .app aberto pelo Finder lê <perfil>/duotela-url.txt.
// O valor continua sujeito a parseDuoTelaUrl (HTTP local apenas).
function readDuoTelaUrlSetting({ env, profileDir, readFile }) {
  if (env.DUOTELA_URL) return env.DUOTELA_URL;
  try { return readFile(path.join(profileDir, URL_FILE), 'utf8').trim(); }
  catch { return undefined; }
}

// Opt-ins para servidor Dalari Cine fora do loopback. Um .app aberto pelo Finder não recebe variáveis de ambiente,
// então um arquivo no perfil com o conteúdo "1" equivale à variável.
function readFlag({ env, profileDir, readFile }, envName, fileName) {
  if (env[envName]) return env[envName] === '1';
  try { return readFile(path.join(profileDir, fileName), 'utf8').trim() === '1'; }
  catch { return false; }
}
const readAllowLanSetting = args => readFlag(args, 'DUOTELA_ALLOW_LAN', LAN_FILE);       // HTTP em IPv4 privado
const readAllowRemoteSetting = args => readFlag(args, 'DUOTELA_ALLOW_REMOTE', REMOTE_FILE); // HTTPS na internet

module.exports = { isInsideAppBundle, resolveProfileDir, migrateLegacyProfile, LEGACY_PROFILE_NAME, readDuoTelaUrlSetting, readAllowLanSetting, readAllowRemoteSetting, PROFILE_NAME, URL_FILE, LAN_FILE, REMOTE_FILE };
