// Peças de formatação das mensagens do Telegram. Pensado para leitura rápida (inclusive com TDAH):
// o veredito vem primeiro (🟢 🟡 🔴), frases curtas, nomes em português no lugar de códigos internos, barras visuais
// e uma linha "O que fazer" no fim. As mensagens usam HTML do Telegram (<b>), então todo texto variável passa por esc().

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const n = (v) => Math.round(Number(v) || 0).toLocaleString('pt-BR');
export const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
export const pctText = (a, b) => { const p = b ? (a * 100) / b : 0; if (p > 0 && p < 0.1) return 'menos de 0,1%'; return (p > 0 && p < 10 ? p.toFixed(1).replace('.', ',') : String(Math.round(p))) + '%'; };

/** Barra de progresso de 10 posições: ▓▓▓░░░░░░░ */
export function bar(value, max, size = 10) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = value > 0 ? Math.max(1, Math.round(ratio * size)) : 0;
  return '▓'.repeat(Math.min(size, filled)) + '░'.repeat(size - Math.min(size, filled));
}

export const LIGHT = { ok: '\u{1F7E2}', warn: '\u{1F7E1}', bad: '\u{1F534}', none: '⚪' };
export const worst = (levels) => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');
export const VERDICT = {
  ok: '\u{1F7E2} <b>Tudo certo</b>',
  warn: '\u{1F7E1} <b>Atenção</b>',
  bad: '\u{1F534} <b>Problema</b>',
};

// Nomes em português dos contadores e das suas chaves
export const NAMES = {
  room_created: 'Salas criadas',
  call_started: 'Chamadas iniciadas',
  call_ended: 'Chamadas encerradas',
  route: 'Como a voz conectou',
  pair_code: 'Códigos gerados pelo Host',
  pair_try: 'Códigos digitados por convidados',
  pair_found: 'Host recebeu o pedido',
  pair_open: 'Conexão direta abriu',
  pair_joined: 'Entraram na sala',
  pair_fail: 'Pareamentos que falharam',
  voice_failed: 'Voz que não conectou',
  voice_quality: 'Qualidade da voz',
  connect_time: 'Tempo para a voz conectar',
  app_error: 'Erros do app',
};
export const KEYS = {
  pair_fail: { timeout: 'o Host não respondeu a tempo', link: 'a conexão direta não abriu', join: 'a sala recusou o pedido', relay: 'o serviço de encontro está fora' },
  voice_quality: { good: 'boa', fair: 'média', poor: 'ruim' },
  connect_time: { '<3s': 'menos de 3 s', '3-10s': '3 a 10 s', '>10s': 'mais de 10 s' },
  call_ended: { '<5m': 'menos de 5 min', '5-30m': '5 a 30 min', '30m-2h': '30 min a 2 h', '>2h': 'mais de 2 h' },
  route: { host: 'rede local', srflx: 'direta pela internet', prflx: 'direta pela internet', relay: 'retransmitida', none: 'sem rota' },
};
export const keyName = (name, key) => KEYS[name]?.[key] ?? key;

// Erros do app: o que significam e o que fazer (curto)
export const APP_ERRORS = {
  mic_denied: ['microfone bloqueado', 'A pessoa negou a permissão. É comum e esperado; só preocupa se for muita gente.'],
  mic_missing: ['sem microfone', 'Nenhum microfone encontrado no computador da pessoa.'],
  mic_busy: ['microfone ocupado por outro app', 'Outro programa está usando o microfone.'],
  mic_insecure: ['página sem permissão de microfone', 'Aconteceu fora do app instalado. Confira como a pessoa abriu.'],
  player_fail: ['vídeo do YouTube não abriu', 'Alguns vídeos bloqueiam a reprodução embutida. Costuma ser caso isolado.'],
  room_lost: ['sala caiu e não voltou', 'A reconexão automática falhou. Veja se o serviço de encontro (ntfy.sh) está fora.'],
  update_fail: ['atualização automática falhou', 'Confira se a última Release tem os arquivos latest.json e latest.json.sig.'],
  unexpected: ['erro inesperado no app', 'Provável bug. Veja se concentra numa versão (comando Versões).'],
};
export const appErrorName = (k) => APP_ERRORS[k]?.[0] ?? k;

export const sum = (rows, name, key) => rows.filter((r) => r.name === name && (key === undefined || r.key === key)).reduce((a, r) => a + r.n, 0);
export const byKey = (rows, name) => { const m = {}; for (const r of rows) if (r.name === name) m[r.key] = (m[r.key] || 0) + r.n; return m; };
export const sortedEntries = (m) => Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

// Botões fixos no teclado do Telegram: tocar neles equivale a digitar o comando
export const BUTTONS = [
  ['\u{1F6A6} Está tudo bem?', '/status'],
  ['\u{1F465} Agora', '/agora'],
  ['\u{1F4C5} Hoje', '/hoje'],
  ['\u{1F5D3} Semana', '/semana'],
  ['\u{1F6A8} Erros', '/erros'],
  ['☁️ Cloudflare', '/cloudflare'],
  ['\u{1F4E6} Versões', '/versoes'],
  ['❓ Ajuda', '/ajuda'],
];
export const KEYBOARD = {
  keyboard: [BUTTONS.slice(0, 2), BUTTONS.slice(2, 4), BUTTONS.slice(4, 6), BUTTONS.slice(6, 8)].map((row) => row.map(([text]) => ({ text }))),
  resize_keyboard: true,
  is_persistent: true,
};
const plain = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const BY_LABEL = new Map(BUTTONS.map(([label, cmd]) => [plain(label), cmd]));
// Atalhos em palavras comuns (sem barra) para quem digitar no lugar de tocar
for (const [word, cmd] of [['status', '/status'], ['ok', '/status'], ['tudo bem', '/status'], ['agora', '/agora'], ['hoje', '/hoje'], ['semana', '/semana'], ['erros', '/erros'], ['erro', '/erros'], ['cloudflare', '/cloudflare'], ['versoes', '/versoes'], ['ajuda', '/ajuda'], ['menu', '/ajuda'], ['oi', '/ajuda']]) BY_LABEL.set(word, cmd);

/** "/agora@MeuBot x", "🚦 Está tudo bem?", "agora" -> "/agora"... ou null. */
export function commandFromText(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (t.startsWith('/')) return t.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  return BY_LABEL.get(plain(t)) ?? null;
}

export const OS_NAMES = { win: 'Windows', mac: 'macOS', linux: 'Linux', other: 'outro sistema' };
