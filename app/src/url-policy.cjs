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

module.exports = { NETFLIX_URL, netflixNavigationAllowed, parseDuoTelaUrl, sameDuoTelaOrigin, isPrivateLanHost, insecureOriginToTreatAsSecure };
