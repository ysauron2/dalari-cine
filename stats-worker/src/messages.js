// Textos das respostas e dos avisos do Telegram. Regras: veredito primeiro, frases curtas, português simples,
// no máximo uns 15 linhas, e "O que fazer" no fim quando houver algo a fazer. HTML do Telegram (<b>).
import { esc, n, pct, bar, LIGHT, VERDICT, worst, NAMES, keyName, APP_ERRORS, appErrorName, sum, byKey, sortedEntries, BUTTONS } from './format.js';

const rowsOf = (s) => s?.counters || [];
const people = (v) => `${n(v)} ${Number(v) === 1 ? 'pessoa' : 'pessoas'}`;

// ---------- leitura dos números do dia: um único lugar decide o que é bom, atenção ou problema ----------
export function health(day, cf) {
  const rows = rowsOf(day);
  const items = [];
  const tried = sum(rows, 'pair_try'), joined = sum(rows, 'pair_joined'), pairFails = sum(rows, 'pair_fail');
  if (tried >= 5) {
    const rate = pairFails / tried;
    const level = rate >= 0.4 ? 'bad' : rate >= 0.2 ? 'warn' : 'ok';
    items.push({ level, text: `Pareamento: ${joined} de ${tried} chegaram à sala (${pct(joined, tried)}%)`,
      tip: level === 'ok' ? null : 'Toque em 📅 Hoje para ver onde o pareamento falha.' });
  } else items.push({ level: 'none', text: tried ? `Pareamento: só ${tried} tentativa${tried > 1 ? 's' : ''} hoje (pouco para avaliar)` : 'Pareamento: sem tentativas hoje' });

  const calls = sum(rows, 'call_started'), voiceFails = sum(rows, 'voice_failed');
  if (calls >= 5 || voiceFails >= 5) {
    const rate = calls ? voiceFails / calls : 1;
    const level = rate >= 0.4 || voiceFails >= 8 ? 'bad' : rate >= 0.2 ? 'warn' : 'ok';
    items.push({ level, text: `Voz: não conectou ${voiceFails} ${voiceFails === 1 ? 'vez' : 'vezes'} em ${calls} chamada${calls === 1 ? '' : 's'}`, tip: level === 'ok' ? null : 'Pode ser a rede de alguém. Se repetir, o servidor TURN resolve.' });
  } else items.push({ level: 'none', text: calls ? `Voz: ${calls} chamada${calls > 1 ? 's' : ''} hoje (pouco para avaliar)` : 'Voz: sem chamadas hoje' });

  const q = byKey(rows, 'voice_quality'), qTotal = (q.good || 0) + (q.fair || 0) + (q.poor || 0);
  if (qTotal >= 5) {
    const rate = (q.poor || 0) / qTotal;
    const level = rate >= 0.4 ? 'bad' : rate >= 0.2 ? 'warn' : 'ok';
    items.push({ level, text: `Qualidade da voz: ${pct(q.good || 0, qTotal)}% boa, ${pct(q.poor || 0, qTotal)}% ruim`, tip: level === 'ok' ? null : 'Toque em 📅 Hoje: veja o tempo para conectar e a rota da voz.' });
  }

  const errs = byKey(rows, 'app_error'), errTotal = Object.values(errs).reduce((a, v) => a + v, 0);
  const errLevel = errTotal >= 10 || Object.values(errs).some((v) => v >= 5) ? 'bad' : errTotal >= 1 ? 'warn' : 'ok';
  const topErr = sortedEntries(errs)[0];
  items.push({ level: errLevel, text: errTotal ? `Erros do app: ${errTotal} (mais comum: ${appErrorName(topErr[0])})` : 'Erros do app: nenhum', tip: errLevel === 'ok' ? null : 'Toque em 🚨 Erros: lá explico cada tipo.' });

  if (cf?.configured) {
    const w = cf.workers && !cf.workers.error ? pct(cf.workers.requests, 100000) : 0;
    const dw = cf.d1 && !cf.d1.error && cf.d1.hasRows ? pct(cf.d1.rowsWritten, 100000) : 0;
    const dr = cf.d1 && !cf.d1.error && cf.d1.hasRows ? pct(cf.d1.rowsRead, 5000000) : 0;
    const top = Math.max(w, dw, dr);
    const level = top >= 70 ? 'bad' : top >= 50 ? 'warn' : 'ok';
    items.push({ level, text: `Cloudflare: ${top}% do limite grátis usado hoje`, tip: level === 'ok' ? null : 'Toque em ☁️ Cloudflare para ver qual limite está perto.' });
  }
  return { level: worst(items.map((i) => i.level)), items };
}

// ---------- 🚦 Está tudo bem? ----------
export function statusText(day, cf, panelUrl = '') {
  const h = health(day, cf);
  const live = day.now?.active || 0;
  const look = h.items.filter((i) => i.level === 'warn' || i.level === 'bad').length;
  const lines = ['\u{1F6A6} <b>Está tudo bem?</b>', '', h.level === 'ok' ? VERDICT.ok : `${VERDICT[h.level]} — ${look} ${look === 1 ? 'ponto' : 'pontos'} para olhar`, '', `\u{1F465} Agora: ${people(live)} com o app aberto`];
  for (const i of h.items) lines.push(`${LIGHT[i.level]} ${esc(i.text)}`);
  const tips = [...new Set(h.items.filter((i) => i.level === 'bad' && i.tip).concat(h.items.filter((i) => i.level === 'warn' && i.tip)).map((i) => i.tip))].slice(0, 3);
  lines.push('', '\u{1F449} <b>O que fazer</b>');
  if (tips.length) for (const t of tips) lines.push('• ' + esc(t));
  else lines.push('Nada por agora. \u{1F44D}');
  if (panelUrl) lines.push('', esc(panelUrl));
  return lines.join('\n');
}

// ---------- 👥 Agora ----------
export function nowText(day, panelUrl = '') {
  const t = day.now || { active: 0, room: 0, call: 0 };
  const rows = rowsOf(day);
  const today = (day.dailyActive || []).at(-1)?.n || 0;
  const tried = sum(rows, 'pair_try'), joined = sum(rows, 'pair_joined');
  const lines = ['\u{1F465} <b>Agora</b> (últimos 5 minutos)', ''];
  if (t.active) lines.push(`<b>${people(t.active)}</b> com o app aberto`, `\u{1F3AC} ${t.room} numa sala · \u{1F399} ${t.call} numa chamada`);
  else lines.push('Ninguém com o app aberto agora.');
  lines.push('', '\u{1F4C5} <b>Hoje</b>', `\u{1F464} ${people(today)} usaram`, `\u{1F3AC} ${n(sum(rows, 'room_created'))} salas · \u{1F4DE} ${n(sum(rows, 'call_started'))} chamadas`);
  if (tried) lines.push(`\u{1F517} Pareamento: ${joined} de ${tried} entraram na sala (${pct(joined, tried)}%)`);
  const errs = Object.values(byKey(rows, 'app_error')).reduce((a, v) => a + v, 0);
  if (errs || sum(rows, 'voice_failed')) lines.push(`\u{1F41E} Problemas: ${n(sum(rows, 'voice_failed'))} de voz · ${n(errs)} erros do app`);
  lines.push('', 'Veredito completo: 🚦 Está tudo bem?');
  return lines.join('\n');
}

// ---------- 📅 Hoje (agrupado, só o que aconteceu) ----------
const GROUPS = [
  ['\u{1F3E0} Uso', ['room_created', 'call_started', 'call_ended', 'route']],
  ['\u{1F517} Pareamento por código', ['pair_code', 'pair_try', 'pair_found', 'pair_open', 'pair_joined', 'pair_fail']],
  ['\u{1F399} Voz', ['voice_failed', 'voice_quality', 'connect_time']],
  ['\u{1F41E} Erros do app', ['app_error']],
];
export function todayText(day) {
  const rows = rowsOf(day);
  const lines = ['\u{1F4C5} <b>Hoje</b> (dia UTC: vai até 21h de Brasília)'];
  let any = false;
  for (const [title, names] of GROUPS) {
    const part = [];
    for (const name of names) {
      const byk = byKey(rows, name), total = Object.values(byk).reduce((a, v) => a + v, 0);
      if (!total) continue;
      const keys = Object.keys(byk).filter((k) => k !== '');
      if (!keys.length) part.push(`• ${NAMES[name]}: <b>${n(total)}</b>`);
      else {
        part.push(['voice_quality', 'connect_time', 'route', 'call_ended'].includes(name) ? `• ${NAMES[name]}:` : `• ${NAMES[name]}: <b>${n(total)}</b>`);
        for (const [k, v] of sortedEntries(byk)) part.push(`   ↳ ${esc(name === 'app_error' ? appErrorName(k) : keyName(name, k))}: ${n(v)}`);
      }
    }
    if (part.length) { lines.push('', `<b>${title}</b>`, ...part); any = true; }
  }
  if (!any) lines.push('', 'Ainda nada hoje. Quando alguém usar o app, aparece aqui.');
  return lines.join('\n');
}

// ---------- 🗓 Semana ----------
export function weekText(week, panelUrl = '') {
  const rows = rowsOf(week);
  const tried = sum(rows, 'pair_try'), joined = sum(rows, 'pair_joined');
  const q = byKey(rows, 'voice_quality'), qTotal = (q.good || 0) + (q.fair || 0) + (q.poor || 0);
  const newInstalls = (week.newByDay || []).reduce((a, r) => a + r.n, 0);
  const errs = byKey(rows, 'app_error'), errTotal = Object.values(errs).reduce((a, v) => a + v, 0);
  const lines = ['\u{1F5D3} <b>Resumo da semana</b> (7 dias)', '',
    `\u{1F464} <b>${people(week.wau || 0)}</b> usaram · \u{1F195} ${n(newInstalls)} novas · total ${n(week.total || 0)}`,
    `\u{1F3AC} ${n(sum(rows, 'room_created'))} salas · \u{1F4DE} ${n(sum(rows, 'call_started'))} chamadas`,
    tried ? `\u{1F517} Pareamento: ${pct(joined, tried)}% chegaram à sala (${joined} de ${tried})` : '\u{1F517} Pareamento: sem tentativas',
    qTotal ? `\u{1F399} Voz: ${pct(q.good || 0, qTotal)}% boa · ${pct(q.fair || 0, qTotal)}% média · ${pct(q.poor || 0, qTotal)}% ruim` : '\u{1F399} Voz: sem medições',
    `\u{1F41E} ${n(sum(rows, 'voice_failed'))} falhas de voz · ${n(errTotal)} erros do app`];
  const top = (week.versions || []).slice(0, 3).map((v) => `${esc(v.app)} (${v.n})`).join(', ');
  if (top) lines.push(`\u{1F4E6} Versões: ${top}`);
  if (panelUrl) lines.push('', esc(panelUrl));
  return lines.join('\n');
}

// ---------- 🚨 Erros ----------
export function errorsText(day, week) {
  const a = byKey(rowsOf(day), 'app_error'), b = byKey(rowsOf(week), 'app_error');
  const total = (m) => Object.values(m).reduce((x, v) => x + v, 0);
  const lines = ['\u{1F6A8} <b>Erros do app</b>', '', `Hoje: <b>${total(a)}</b> · Semana: <b>${total(b)}</b>`];
  const all = sortedEntries(b);
  if (!all.length) { lines.push('', 'Nenhum erro nos últimos 7 dias. \u{1F389}'); return lines.join('\n'); }
  for (const [k, v] of all.slice(0, 5)) {
    lines.push('', `• <b>${esc(appErrorName(k))}</b>: ${v} na semana${a[k] ? ` (${a[k]} hoje)` : ''}`, `   \u{1F4A1} ${esc(APP_ERRORS[k]?.[1] || 'sem explicação')}`);
  }
  return lines.join('\n');
}

// ---------- 📦 Versões ----------
export function versionsText(week) {
  const list = (week.versions || []).slice(0, 6);
  const lines = ['\u{1F4E6} <b>Versões em uso</b> (7 dias)', ''];
  if (!list.length) { lines.push('Nenhum dado ainda.'); return lines.join('\n'); }
  const totalN = list.reduce((a, v) => a + v.n, 0), max = Math.max(...list.map((v) => v.n));
  for (const v of list) lines.push(`${bar(v.n, max)} <b>${esc(v.app)}</b> · ${v.n} (${pct(v.n, totalN)}%)`);
  lines.push('', list.length > 1 ? '\u{1F4A1} Quem está numa versão antiga ainda não atualizou. A atualização aparece sozinha no app.' : '\u{1F4A1} Todo mundo está na mesma versão.');
  return lines.join('\n');
}

// ---------- ❓ Ajuda ----------
export function helpText() {
  return ['❓ <b>Como usar</b>', '', 'Toque nos botões embaixo, ou mande o comando:', '',
    '\u{1F6A6} /status — <b>está tudo bem?</b> (comece por aqui)',
    '\u{1F465} /agora — quem está usando agora',
    '\u{1F4C5} /hoje — o que aconteceu hoje',
    '\u{1F5D3} /semana — resumo de 7 dias',
    '\u{1F6A8} /erros — erros do app e o que fazer',
    '☁️ /cloudflare — uso da conta Cloudflare',
    '\u{1F4E6} /versoes — quem atualizou',
    '', 'Eu também aviso sozinho quando algo passar do limite. \u{1F514}'].join('\n');
}

// ---------- 🔔 Avisos automáticos ----------
const ALERT_TIPS = {
  pair_fail_rate: 'Veja em Hoje onde o pareamento falha. Se for "serviço de encontro fora do ar", o ntfy.sh pode estar com problema.',
  voice_fail_rate: 'Pode ser rede difícil dos usuários. Se continuar, vale ligar o servidor TURN.',
  voice_poor: 'Veja em Hoje o tempo de conexão e como a voz conectou.',
  app_errors: 'Toque em Erros para ver os tipos e o que fazer.',
};
export function alertMessage(kind, headline, detail) {
  return [`\u{1F534} <b>${esc(headline)}</b>`, esc(detail), '', `\u{1F449} <b>O que fazer:</b> ${esc(ALERT_TIPS[kind] || 'Abra o painel para ver os detalhes.')}`].join('\n');
}
export function alerts(rows) {
  const out = [];
  const tried = sum(rows, 'pair_try'), pairFails = sum(rows, 'pair_fail');
  if (tried >= 5 && pairFails / tried >= 0.4) {
    const where = sortedEntries(byKey(rows, 'pair_fail')).map(([k, v]) => `${keyName('pair_fail', k)} (${v})`).join(', ');
    out.push({ kind: 'pair_fail_rate', text: alertMessage('pair_fail_rate', 'Pareamento falhando', `${pairFails} de ${tried} tentativas falharam hoje (${pct(pairFails, tried)}%).${where ? ' Motivos: ' + where + '.' : ''}`) });
  }
  const calls = sum(rows, 'call_started'), voiceFails = sum(rows, 'voice_failed');
  if ((calls >= 5 && voiceFails / calls >= 0.4) || voiceFails >= 8) {
    out.push({ kind: 'voice_fail_rate', text: alertMessage('voice_fail_rate', 'Voz falhando', `${voiceFails} vezes a voz não conectou hoje, para ${calls} chamadas iniciadas.`) });
  }
  const q = byKey(rows, 'voice_quality'), qTotal = (q.good || 0) + (q.fair || 0) + (q.poor || 0);
  if (qTotal >= 5 && (q.poor || 0) / qTotal >= 0.4) {
    out.push({ kind: 'voice_poor', text: alertMessage('voice_poor', 'Qualidade da voz ruim', `${q.poor} de ${qTotal} chamadas medidas hoje ficaram ruins (${pct(q.poor, qTotal)}%).`) });
  }
  const errs = byKey(rows, 'app_error'), errTotal = Object.values(errs).reduce((a, v) => a + v, 0);
  if (errTotal >= 10 || Object.values(errs).some((v) => v >= 5)) {
    out.push({ kind: 'app_errors', text: alertMessage('app_errors', 'Muitos erros no app', `${errTotal} erros hoje. Mais comuns: ${sortedEntries(errs).slice(0, 3).map(([k, v]) => `${appErrorName(k)} (${v})`).join(', ')}.`) });
  }
  return out;
}

export const WELCOME = '\u{1F44B} <b>Oi! Eu sou o painel do Dalari Cine.</b>\n\nToque nos botões embaixo para ver como o app está. Comece por \u{1F6A6} <b>Está tudo bem?</b>\n\nEu também aviso aqui quando algo der errado. \u{1F514}';
export const UNKNOWN = 'Não entendi essa. \u{1F642} Toque num dos botões embaixo, ou mande /ajuda.';
export { BUTTONS };

// ---------- 🆕 Novidades de instalação e de versão ----------
import { OS_NAMES } from './format.js';
/** Nova instalação (sem ser a primeira da versão). info: { total, newToday }. */
export function newInstallText(p, info) {
  return ['\u{1F195} <b>Nova instalação</b>', `${esc(OS_NAMES[p.os] || p.os)} \u00B7 versão ${esc(p.app)}`, `\u{1F465} Já são ${n(info.total)} no total (${n(info.newToday)} ${info.newToday === 1 ? 'nova' : 'novas'} hoje)`].join('\n');
}
/** Primeira pessoa a usar uma versão. previousApp: de qual versão atualizou (ou null se for instalação nova). */
export function newVersionText(p, info) {
  const how = info.previousApp ? `Atualizou da ${esc(info.previousApp)}` : 'Instalação nova';
  return [`\u{1F4E6} <b>Primeira pessoa na versão ${esc(p.app)}</b>`, `${how} \u00B7 ${esc(OS_NAMES[p.os] || p.os)}`, '', 'Se algo der errado nessa versão, os avisos de erro chegam por aqui.'].join('\n');
}

// ---------- 🌙 Resumo do dia (22h de Brasília) ----------
export function dailyText(day, cf, panelUrl = '') {
  const h = health(day, cf);
  const rows = rowsOf(day);
  const today = (day.dailyActive || []).at(-1)?.n || 0;
  const newToday = (day.newByDay || []).at(-1)?.n || 0;
  const tried = sum(rows, 'pair_try'), joined = sum(rows, 'pair_joined');
  const look = h.items.filter((i) => i.level === 'warn' || i.level === 'bad').length;
  const lines = ['\u{1F319} <b>Resumo do dia</b>', '', h.level === 'ok' ? VERDICT.ok : `${VERDICT[h.level]} \u2014 ${look} ${look === 1 ? 'ponto' : 'pontos'} para olhar`, '',
    `\u{1F464} ${people(today)} usaram \u00B7 \u{1F195} ${n(newToday)} ${newToday === 1 ? 'nova' : 'novas'}`,
    `\u{1F3AC} ${n(sum(rows, 'room_created'))} salas \u00B7 \u{1F4DE} ${n(sum(rows, 'call_started'))} chamadas`,
    tried ? `\u{1F517} Pareamento: ${joined} de ${tried} entraram na sala (${pct(joined, tried)}%)` : '\u{1F517} Pareamento: sem tentativas'];
  for (const i of h.items.filter((x) => x.level === 'warn' || x.level === 'bad')) lines.push(`${LIGHT[i.level]} ${esc(i.text)}`);
  if (panelUrl) lines.push('', esc(panelUrl));
  return lines.join('\n');
}
