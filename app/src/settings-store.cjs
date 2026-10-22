'use strict';
// Cópia de segurança das configurações do usuário (nome, preferências, histórico, escolhas de áudio...) em um arquivo no perfil.
// A interface guarda tudo no localStorage; se esse armazenamento sumir (limpeza, mudança de endereço do serviço local), o
// preload restaura a partir deste arquivo. Só chaves do app, só texto, com limites de tamanho.
const path = require('node:path');

const FILE = 'settings-backup.json';
const PORT_FILE = 'local-port.txt';
const KEY_RE = /^(duotela-|sessao-a-dois-)[A-Za-z0-9._-]{0,80}$/;
const MAX_VALUE = 200 * 1024, MAX_TOTAL = 1024 * 1024, MAX_KEYS = 64;

// Só chaves do app, valores de texto dentro dos limites; o resto é descartado em silêncio.
function sanitize(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let total = 0, n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (n >= MAX_KEYS) break;
    if (!KEY_RE.test(k) || typeof v !== 'string' || v.length > MAX_VALUE || total + v.length > MAX_TOTAL) continue;
    out[k] = v; total += v.length; n++;
  }
  return out;
}

function readBackup({ fs, dir }) {
  try { return sanitize(JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))); }
  catch { return {}; }
}

// Escrita atômica: arquivo temporário e renomeação, para um desligamento no meio não deixar o arquivo pela metade.
function writeBackup({ fs, dir, data }) {
  const clean = sanitize(data), file = path.join(dir, FILE), tmp = file + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// Porta fixa do serviço local: o localStorage é por endereço (inclui a porta), então a porta precisa ser a mesma a cada abertura.
function readPort({ fs, dir }) {
  try {
    const n = Number(fs.readFileSync(path.join(dir, PORT_FILE), 'utf8').trim());
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 0;
  } catch { return 0; }
}
function writePort({ fs, dir, port }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, PORT_FILE), String(port)); return true; } catch { return false; }
}

module.exports = { sanitize, readBackup, writeBackup, readPort, writePort, KEY_RE, FILE, PORT_FILE, MAX_VALUE, MAX_TOTAL, MAX_KEYS };
