// Painel de estatísticas (uma página só, sem bibliotecas externas). Os dados vêm de /api/summary na mesma origem.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dalari Cine · estatísticas</title>
<style>
  :root{--bg:#090C14;--s1:#171E2B;--s2:#202838;--line:#344050;--ink:#f5f2f5;--mute:#a9b2c2;--coral:#FFAC8F;--pink:#F77FA0;--green:#A6E4C6}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px 16px 60px}
  main{max-width:1080px;margin:0 auto}header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
  h1{margin:0;font-size:24px;letter-spacing:-.03em;flex:1 1 auto}h1 small{display:block;color:var(--mute);font-size:12px;font-weight:400;letter-spacing:0}
  h2{margin:26px 0 10px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--coral)}
  .btn{font:inherit;background:var(--s2);color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:7px 14px;cursor:pointer;text-decoration:none}.btn:hover{border-color:var(--coral)}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .card{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:14px 16px}.card b{display:block;font-size:30px;letter-spacing:-.03em;line-height:1.1}.card span{color:var(--mute);font-size:12px}
  .live b{color:var(--green)}.panel{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:14px 16px;overflow:auto}
  table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #252f40;font-variant-numeric:tabular-nums}th{color:var(--mute);font-weight:600;font-size:12px}
  svg{width:100%;height:auto;display:block}.bar{fill:var(--coral)}.bar2{fill:var(--pink)}.axis{fill:var(--mute);font-size:10px}
  .two{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.note{color:var(--mute);font-size:12px;margin-top:8px}
  #status{color:var(--mute);font-size:12px}
  .funnel .row{display:grid;grid-template-columns:minmax(150px,34%) 1fr 90px;gap:10px;align-items:center;padding:4px 0}.funnel .lbl{color:var(--ink)}
  .funnel .track{background:#0f1522;border-radius:8px;height:18px;overflow:hidden}.funnel .fill{display:block;height:100%;background:linear-gradient(90deg,var(--coral),var(--pink));border-radius:8px;min-width:2px}
  .funnel .val{color:var(--mute);text-align:right;font-variant-numeric:tabular-nums}.fill.good{background:var(--green)}.fill.fair{background:#F5D58A}.fill.poor{background:#F27B7B}
  .heat{display:grid;grid-template-columns:34px repeat(24,1fr);gap:2px;font-size:10px;color:var(--mute)}.heat .c{height:20px;border-radius:3px;background:#0f1522}.heat .h{text-align:center}.heat .d{align-self:center}
</style>
</head>
<body>
<main>
  <header>
    <h1>Dalari Cine<small>Estatísticas anônimas de uso · só quem permitiu envia</small></h1>
    <span id="status">carregando…</span>
    <select id="days" class="btn" aria-label="Período"><option value="7">7 dias</option><option value="30" selected>30 dias</option><option value="90">90 dias</option></select>
    <a class="btn" id="csv" href="/api/export.csv?days=30">Baixar planilha</a>
    <button class="btn" id="tgtest" type="button">Testar Telegram</button>
  </header>

  <h2>Agora</h2>
  <div class="grid live" id="now"></div>

  <h2>Pessoas ativas</h2>
  <div class="grid" id="actives"></div>
  <div class="panel" style="margin-top:12px"><svg id="dau" viewBox="0 0 800 200" role="img" aria-label="Pessoas ativas por dia"></svg>
    <div class="note">Cada barra é um dia (UTC): instalações que abriram o app e permitiram estatísticas.</div></div>

  <h2>Uso por dia</h2>
  <div class="two">
    <div class="panel"><table id="usage"></table></div>
    <div class="panel"><svg id="calls" viewBox="0 0 800 200" role="img" aria-label="Chamadas iniciadas por dia"></svg><div class="note">Chamadas de voz iniciadas por dia.</div></div>
  </div>

  <h2>Rota e duração da voz</h2>
  <div class="two">
    <div class="panel"><table id="routes"></table><div class="note">Rota usada nas chamadas: <b>host</b>/<b>srflx</b> = conexão direta; <b>relay</b> = passou por servidor TURN.</div></div>
    <div class="panel"><table id="durations"></table><div class="note">Duração das chamadas, em faixas.</div></div>
  </div>

  <h2>Funil do código curto</h2>
  <div class="two">
    <div class="panel funnel" id="funnel"></div>
    <div class="panel"><table id="pairfail"></table><div class="note">Onde o pareamento falhou: <b>timeout</b> = o Host não respondeu; <b>relay</b> = serviço de encontro inacessível; <b>link</b> = a conexão direta não abriu; <b>join</b> = a sala recusou o pedido.</div></div>
  </div>

  <h2>Qualidade das chamadas</h2>
  <div class="two">
    <div class="panel funnel" id="quality"></div>
    <div class="panel funnel" id="connect"></div>
  </div>
  <p class="note">Qualidade em faixas, medida ~20 s após conectar: <b>boa</b> = perda &lt; 2%, jitter &lt; 30 ms, atraso &lt; 150 ms; <b>ruim</b> = perda &gt; 8%, jitter &gt; 80 ms ou atraso &gt; 400 ms. "Tempo para conectar" vai do clique em Ligar voz até a voz conectada.</p>

  <h2>Erros do app</h2>
  <div class="two">
    <div class="panel"><table id="errors"></table></div>
    <div class="panel"><div class="note">Só categorias fixas, contadas por dia: <b>mic_denied</b> = microfone bloqueado; <b>mic_missing</b> = sem microfone; <b>mic_busy</b> = outro app usa o microfone; <b>mic_insecure</b> = página sem permissão de microfone; <b>player_fail</b> = vídeo do YouTube não abriu; <b>room_lost</b> = a sala caiu de forma inesperada; <b>update_fail</b> = a atualização automática falhou; <b>unexpected</b> = erro inesperado no app (só a contagem, sem detalhes).</div></div>
  </div>

  <h2>Horários de pico</h2>
  <div class="panel"><div class="heat" id="heat"></div><div class="note">Pessoas ativas por hora do dia e dia da semana, no <b>seu fuso horário</b> (soma do período). Mais escuro = mais gente.</div></div>

  <h2>Retenção</h2>
  <div class="panel"><table id="retention"></table><div class="note">Por semana de entrada: quantas voltaram no dia seguinte (D1) e em algum dos 7 dias seguintes. Só entram semanas com pelo menos 8 dias.</div></div>

  <h2>Versões e sistemas (últimos 7 dias)</h2>
  <div class="two">
    <div class="panel"><table id="versions"></table></div>
    <div class="panel"><table id="systems"></table></div>
  </div>
  <p class="note">Sem nomes, sem endereço IP guardado e sem o que as pessoas assistem. Os números somam só quem aceitou enviar estatísticas, então representam uma parte do uso real.</p>
</main>
<script>
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n ?? 0).toLocaleString('pt-BR');
const SO = { win: 'Windows', mac: 'macOS', linux: 'Linux', other: 'Outro' };
function card(parent, value, label) { const d = document.createElement('div'); d.className = 'card'; const b = document.createElement('b'); b.textContent = fmt(value); const s = document.createElement('span'); s.textContent = label; d.append(b, s); parent.append(d); }
function table(el, head, rows) {
  el.replaceChildren();
  const tr = document.createElement('tr'); for (const h of head) { const th = document.createElement('th'); th.textContent = h; tr.append(th); } el.append(tr);
  if (!rows.length) { const r = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = head.length; td.textContent = 'sem dados ainda'; r.append(td); el.append(r); return; }
  for (const row of rows) { const r = document.createElement('tr'); for (const c of row) { const td = document.createElement('td'); td.textContent = c; r.append(td); } el.append(r); }
}
function bars(svg, points, cls) {
  svg.replaceChildren();
  const NS = 'http://www.w3.org/2000/svg', W = 800, H = 200, pad = 26, max = Math.max(1, ...points.map((p) => p.n));
  const bw = points.length ? (W - pad) / points.length : 0;
  points.forEach((p, i) => {
    const h = Math.round(((H - pad - 14) * p.n) / max);
    const r = document.createElementNS(NS, 'rect'); r.setAttribute('class', cls); r.setAttribute('x', String(pad + i * bw + 1)); r.setAttribute('y', String(H - pad - h)); r.setAttribute('width', String(Math.max(1, bw - 3))); r.setAttribute('height', String(h)); r.setAttribute('rx', '2');
    const t = document.createElementNS(NS, 'title'); t.textContent = p.day + ': ' + p.n; r.append(t); svg.append(r);
    if (points.length <= 31 && (i % Math.ceil(points.length / 8) === 0)) { const x = document.createElementNS(NS, 'text'); x.setAttribute('class', 'axis'); x.setAttribute('x', String(pad + i * bw)); x.setAttribute('y', String(H - 8)); x.textContent = p.day.slice(5); svg.append(x); }
  });
  const m = document.createElementNS(NS, 'text'); m.setAttribute('class', 'axis'); m.setAttribute('x', '0'); m.setAttribute('y', '12'); m.textContent = String(max); svg.append(m);
}
function dayRange(days) { const out = []; const t = Date.now(); for (let i = days - 1; i >= 0; i--) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10)); return out; }
const dayName = { room_created: 'Salas criadas', call_started: 'Chamadas iniciadas', voice_failed: 'Falhas de voz' };

async function load() {
  const days = Number($('days').value);
  $('csv').href = '/api/export.csv?days=' + days;
  const res = await fetch('/api/summary?days=' + days, { cache: 'no-store' });
  if (!res.ok) { $('status').textContent = 'erro ' + res.status; return; }
  const s = await res.json();
  $('status').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR');
  $('now').replaceChildren(); card($('now'), s.now.active, 'com o app aberto'); card($('now'), s.now.room, 'em sala'); card($('now'), s.now.call, 'em chamada de voz');
  $('actives').replaceChildren(); card($('actives'), s.dailyActive.at(-1)?.n ?? 0, 'último dia com dados'); card($('actives'), s.wau, 'últimos 7 dias'); card($('actives'), s.mau, 'últimos 30 dias'); card($('actives'), s.total, 'instalações vistas (total)');
  const range = dayRange(days), byDay = Object.fromEntries(s.dailyActive.map((r) => [r.day, r.n]));
  bars($('dau'), range.map((d) => ({ day: d, n: byDay[d] || 0 })), 'bar');
  const cnt = (name) => { const m = {}; for (const c of s.counters) if (c.name === name) m[c.day] = (m[c.day] || 0) + c.n; return m; };
  const rooms = cnt('room_created'), calls = cnt('call_started'), fails = cnt('voice_failed');
  bars($('calls'), range.map((d) => ({ day: d, n: calls[d] || 0 })), 'bar2');
  const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
  table($('usage'), ['Métrica', 'Total no período'], [['Salas criadas', fmt(sum(rooms))], ['Chamadas iniciadas', fmt(sum(calls))], ['Falhas de voz', fmt(sum(fails))], ['Taxa de falha', sum(calls) ? ((100 * sum(fails)) / sum(calls)).toFixed(1) + '%' : '—'], ['Novas instalações', fmt(s.newByDay.reduce((a, r) => a + r.n, 0))]]);
  const group = (name) => { const m = {}; for (const c of s.counters) if (c.name === name) m[c.key] = (m[c.key] || 0) + c.n; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  table($('routes'), ['Rota', 'Chamadas'], group('route').map(([k, n]) => [k, fmt(n)]));
  table($('durations'), ['Duração', 'Chamadas'], group('call_ended').map(([k, n]) => [k, fmt(n)]));
  table($('versions'), ['Versão', 'Instalações'], s.versions.map((r) => [r.app, fmt(r.n)]));
  table($('systems'), ['Sistema', 'Instalações'], s.systems.map((r) => [SO[r.os] || r.os, fmt(r.n)]));
  renderMore(s);
}
function funnelRows(el, rows, base, cls) {
  el.replaceChildren();
  if (!rows.length || rows.every((r) => !r[1])) { const p = document.createElement('div'); p.className = 'note'; p.textContent = 'sem dados ainda'; el.append(p); return; }
  for (const [label, n, c] of rows) {
    const row = document.createElement('div'); row.className = 'row';
    const l = document.createElement('span'); l.className = 'lbl'; l.textContent = label;
    const t = document.createElement('span'); t.className = 'track'; const f = document.createElement('span'); f.className = 'fill ' + (c || cls || ''); f.style.width = (base ? Math.min(100, (100 * n) / base) : 0) + '%'; t.append(f);
    const v = document.createElement('span'); v.className = 'val'; v.textContent = fmt(n) + (base ? ' · ' + Math.round((100 * n) / base) + '%' : ''); row.append(l, t, v); el.append(row);
  }
}
function heat(el, hourly) {
  el.replaceChildren();
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0)); let max = 0;
  for (const r of hourly) {
    const d = new Date(r.day + 'T' + String(r.hour).padStart(2, '0') + ':00:00Z');           // UTC -> fuso local de quem olha
    grid[d.getDay()][d.getHours()] += r.n; max = Math.max(max, grid[d.getDay()][d.getHours()]);
  }
  const names = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  el.append(document.createElement('span'));
  for (let h = 0; h < 24; h++) { const x = document.createElement('span'); x.className = 'h'; x.textContent = h % 3 === 0 ? String(h) : ''; el.append(x); }
  for (let d = 0; d < 7; d++) {
    const n = document.createElement('span'); n.className = 'd'; n.textContent = names[d]; el.append(n);
    for (let h = 0; h < 24; h++) {
      const c = document.createElement('span'); c.className = 'c'; const v = grid[d][h];
      if (v && max) c.style.background = 'rgba(255,172,143,' + (0.15 + 0.85 * (v / max)).toFixed(2) + ')';
      c.title = names[d] + ' ' + h + 'h: ' + v; el.append(c);
    }
  }
}
function renderMore(s) {
  const cnt = (name) => { const m = {}; for (const c of s.counters) if (c.name === name) m[c.key] = (m[c.key] || 0) + c.n; return m; };
  const one = (name) => Object.values(cnt(name)).reduce((a, b) => a + b, 0);
  const tried = one('pair_try');
  funnelRows($('funnel'), [['Código gerado pelo Host', one('pair_code')], ['Convidado digitou o código', tried], ['Host recebeu a oferta', one('pair_found')], ['Conexão direta abriu', one('pair_open')], ['Convidado pediu entrada na sala', one('pair_joined')]], tried || one('pair_code'));
  const fails = cnt('pair_fail'); table($('pairfail'), ['Falha', 'Vezes'], Object.entries(fails).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, fmt(n)]));
  const q = cnt('voice_quality'), qTotal = (q.good || 0) + (q.fair || 0) + (q.poor || 0);
  funnelRows($('quality'), [['Boa', q.good || 0, 'good'], ['Média', q.fair || 0, 'fair'], ['Ruim', q.poor || 0, 'poor']], qTotal);
  const c = cnt('connect_time'), cTotal = (c['<3s'] || 0) + (c['3-10s'] || 0) + (c['>10s'] || 0);
  funnelRows($('connect'), [['Menos de 3 s', c['<3s'] || 0, 'good'], ['3 a 10 s', c['3-10s'] || 0, 'fair'], ['Mais de 10 s', c['>10s'] || 0, 'poor']], cTotal);
  const errs = cnt('app_error'); table($('errors'), ['Erro', 'Vezes'], Object.entries(errs).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, fmt(n)]));
  heat($('heat'), s.hourly || []);
  table($('retention'), ['Semana de entrada', 'Pessoas', 'Voltou no dia seguinte', 'Voltou em 7 dias'], (s.retention || []).map((r) => [r.start, fmt(r.size), r.size ? Math.round((100 * r.d1) / r.size) + '% (' + r.d1 + ')' : '—', r.size ? Math.round((100 * r.w1) / r.size) + '% (' + r.w1 + ')' : '—']));
}
$('days').addEventListener('change', load);
$('tgtest').addEventListener('click', async () => {
  const b = $('tgtest'); b.disabled = true; const old = b.textContent; b.textContent = 'Enviando…';
  try { const r = await fetch('/api/alert-test', { method: 'POST' }); b.textContent = r.ok ? 'Enviado ✓ (veja o Telegram)' : r.status === 409 ? 'Telegram não configurado' : 'Falhou (' + r.status + ')'; }
  catch { b.textContent = 'Falhou (rede)'; }
  setTimeout(() => { b.textContent = old; b.disabled = false; }, 4000);
});
load(); setInterval(load, 30000);
</script>
</body>
</html>`;
