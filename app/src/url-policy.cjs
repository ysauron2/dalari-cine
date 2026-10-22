'use strict';

const NETFLIX_URL = 'https://www.netflix.com/';

function netflixNavigationAllowed(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      !url.username && !url.password &&
      !url.port &&
      (url.hostname === 'netflix.com' || url.hostname.endsWith('.netflix.com'));
  } catch {
    return false;
  }
}

// Busca da Netflix com o nome de um título (a janela da Netflix abre aqui; o título é só texto, sem caracteres de controle e com tamanho limitado)
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');
function netflixSearchUrl(title) {
  if (typeof title !== 'string') return null;
  const clean = title.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return clean ? NETFLIX_URL + 'search?q=' + encodeURIComponent(clean) : null;
}

// Convite com um toque: dalari://entrar/XXXX-XXXX (o código curto do Host, alfabeto Crockford, igual ao de web/server/p2p-rendezvous.js).
// Só esse formato é aceito: nada de outro endereço, parâmetro, porta ou credencial.
const JOIN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function normalizeJoinCode(text) {
  const raw = String(text === undefined || text === null ? '' : text).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return raw.length === 8 && [...raw].every(c => JOIN_ALPHABET.includes(c)) ? raw.slice(0, 4) + '-' + raw.slice(4) : null;
}
function parseJoinUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 100) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'dalari:' || url.hostname !== 'entrar' || url.username || url.password || url.port || url.search || url.hash) return null;
    const m = /^\/([^/]+)\/?$/.exec(url.pathname);
    return m ? normalizeJoinCode(decodeURIComponent(m[1])) : null;
  } catch {
    return null;
  }
}
// Entre os argumentos de linha de comando (Windows/Linux entregam o link assim), o primeiro convite válido
function findJoinCode(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const code = parseJoinUrl(arg);
    if (code) return code;
  }
  return null;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

// Somente IPv4 literal nas faixas privadas RFC 1918 (10/8, 172.16/12, 192.168/16).
function isPrivateLanHost(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Padrão: só HTTP em loopback. Opt-ins explícitos: allowLan (HTTP em IPv4 privado) e allowRemote (HTTPS em qualquer host,
// para um servidor Dalari Cine na internet atrás de TLS). Credenciais, consulta e fragmento continuam proibidos.
function parseDuoTelaUrl(raw, { allowLan = false, allowRemote = false } = {}) {
  if (!raw) return null;
  const url = new URL(raw);
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  const httpOk = url.protocol === 'http:' && (loopback || (allowLan && isPrivateLanHost(url.hostname)));
  const httpsOk = url.protocol === 'https:' && allowRemote && !!url.hostname;
  if (!httpOk && !httpsOk) {
    throw new Error('DUOTELA_URL deve ser HTTP em 127.0.0.1 ou localhost. Para um servidor na rede privada (HTTP) defina DUOTELA_ALLOW_LAN=1; para um servidor na internet (HTTPS) defina DUOTELA_ALLOW_REMOTE=1.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('DUOTELA_URL não deve conter credenciais, consulta ou fragmento.');
  }
  return url;
}

// O Chromium só libera microfone em origem segura. Para um servidor HTTP na LAN, trata como segura
// exatamente essa origem (nunca curinga). Retorna null para loopback, que já é seguro.
function insecureOriginToTreatAsSecure(url) {
  return url && isPrivateLanHost(url.hostname) ? url.origin : null;
}

function sameDuoTelaOrigin(raw, allowedOrigin) {
  try {
    const url = new URL(raw);
    return url.origin === allowedOrigin && !url.username && !url.password;
  } catch {
    return false;
  }
}

module.exports = { NETFLIX_URL, netflixNavigationAllowed, netflixSearchUrl, normalizeJoinCode, parseJoinUrl, findJoinCode, parseDuoTelaUrl, sameDuoTelaOrigin, isPrivateLanHost, insecureOriginToTreatAsSecure };
