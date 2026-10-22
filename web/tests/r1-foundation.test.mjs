import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../server/motion.js');
const Media = require('../src/media.js');
const { createRoomService } = require('../server/room-service.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const exists = (p) => existsSync(new URL(p, import.meta.url));

// ---------- movimento ----------
test('nível de movimento: automático segue o sistema; escolha do usuário vence o sistema', () => {
  assert.equal(M.resolve('auto', false), 'full');
  assert.equal(M.resolve('auto', true), 'reduced');
  assert.equal(M.resolve('full', true), 'full', 'Completo vence o "reduzir movimento" do sistema');
  assert.equal(M.resolve('reduced', false), 'reduced');
  assert.equal(M.resolve('off', false), 'off');
  for (const bad of [undefined, null, '', 'xyz', 5, {}]) assert.equal(M.resolve(bad, true), 'reduced', 'valor inválido vira automático');
  assert.match(M.explain('auto', true), /porque o seu sistema pede menos movimento/);
  assert.match(M.explain('auto', false), /Completo, porque o seu sistema não pede/);
  assert.match(M.explain('full', true), /Completo, por escolha sua/);
});

function fakeWindow({ osReduced = false, stored = null } = {}) {
  const listeners = {}; const attrs = {}; const els = {};
  const storage = new Map(stored === null ? [] : [['duotela-motion', stored]]);
  const mq = { matches: osReduced, addEventListener: (t, fn) => { listeners[t] = fn; } };
  const doc = { readyState: 'complete', documentElement: { setAttribute: (k, v) => { attrs[k] = v; } }, getElementById: (id) => els[id] || null, addEventListener() {} };
  const win = { document: doc, matchMedia: () => mq, localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) } };
  return { win, attrs, storage, mq, els, fireSystemChange: (v) => { mq.matches = v; listeners.change?.(); } };
}

test('movimento no navegador: aplica em <html data-motion>, guarda a escolha e reage à mudança do sistema só no automático', () => {
  const t = fakeWindow({ osReduced: true });
  const api = M.install(t.win);
  assert.equal(t.attrs['data-motion'], 'reduced', 'sistema pede menos movimento e a escolha é automática');
  assert.equal(api.reduced(), true); assert.equal(api.choice(), 'auto');
  assert.equal(api.set('full'), true);
  assert.equal(t.attrs['data-motion'], 'full'); assert.equal(api.reduced(), false); assert.equal(t.storage.get('duotela-motion'), 'full');
  t.fireSystemChange(false); t.fireSystemChange(true);
  assert.equal(t.attrs['data-motion'], 'full', 'escolha manual não muda quando o sistema muda');
  api.set('auto');
  assert.equal(t.attrs['data-motion'], 'reduced');
  t.fireSystemChange(false);
  assert.equal(t.attrs['data-motion'], 'full', 'automático acompanha o sistema');
  assert.equal(api.set('bogus'), false); assert.equal(api.choice(), 'auto', 'valor inválido é recusado');
  assert.equal(api.set('off'), true); assert.equal(api.level(), 'off'); assert.equal(api.reduced(), true);
});

test('movimento: lê a escolha guardada, ignora lixo, avisa quem ouve e sobrevive a armazenamento quebrado', () => {
  assert.equal(M.install(fakeWindow({ stored: 'off' }).win).level(), 'off');
  assert.equal(M.install(fakeWindow({ stored: 'lixo', osReduced: false }).win).level(), 'full');
  const t = fakeWindow(); const api = M.install(t.win);
  const seen = []; const off = api.onChange((level, choice) => seen.push([level, choice]));
  api.onChange(() => { throw new Error('ouvinte com defeito'); });
  api.set('reduced'); off(); api.set('full');
  assert.deepEqual(seen, [['reduced', 'reduced']], 'o ouvinte removido para de receber, e um ouvinte com defeito não derruba os outros');
  const broken = fakeWindow(); broken.win.localStorage = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
  const b = M.install(broken.win);
  assert.equal(b.set('off'), true); assert.equal(b.level(), 'off', 'sem armazenamento vale só nesta abertura');
});

test('movimento: o seletor de Perfil é ligado ao módulo e mostra por que o nível é o que é', () => {
  const t = fakeWindow({ osReduced: true });
  const select = { value: '', dataset: {}, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } };
  const note = { textContent: '' };
  t.els['motion-select'] = select; t.els['motion-note'] = note;
  const api = M.install(t.win);
  assert.equal(select.value, 'auto'); assert.match(note.textContent, /Reduzido, porque o seu sistema/);
  select.value = 'full'; select.handlers.change();
  assert.equal(api.level(), 'full'); assert.match(note.textContent, /Completo, por escolha sua/);
});

test('CSS de movimento: nenhuma regra global solta apaga animações; a regra geral tem especificidade zero', () => {
  const css = read('../styles/motion.css');
  assert.match(css, /:where\(:root\[data-motion="reduced"\], :root\[data-motion="off"\]\) \*,/);
  assert.doesNotMatch(css, /(^|\n)\s*\*\s*\{[^}]*animation:\s*none/, 'sem * { animation: none }');
  assert.match(css, /:root\[data-motion="reduced"\] \{ --motion-scale: \.01; \}/);
  assert.match(css, /:root\[data-motion="off"\] \{ --motion-scale: 0; \}/);
  for (const file of ['../index.html', '../server/online-ui.js', '../server/chat.js', '../server/first-run.js', '../server/tribute.js']) {
    assert.doesNotMatch(read(file), /@media\s*\(prefers-reduced-motion/, file + ' não deve depender só do sistema: use data-motion');
  }
  assert.match(read('../server/online-ui.js'), /:where\(:root\[data-motion="reduced"\],:root\[data-motion="off"\]\) \.reaction-fly\{animation:react-fade 2s linear forwards!important;animation-duration:2s!important\}/);
});

// ---------- tokens, fonte e página ----------
test('tokens: nomes antigos mantidos com os mesmos valores e escalas novas definidas', () => {
  const tokens = read('../styles/tokens.css');
  const html = read('../index.html');
  const root = /:root\{font-family[^}]*\}/.exec(html)[0];
  for (const name of ['base', 'panel', 'panel2', 'muted', 'line', 'accent', 'accent2', 'pink', 'green', 'radius']) {
    const inline = new RegExp('--' + name + ':\\s*([^;}]+)').exec(root)?.[1].trim();
    const token = new RegExp('--' + name + ':\\s*([^;]+);').exec(tokens)?.[1].trim();
    assert.equal(token, inline, '--' + name);
  }
  for (const t of ['--space-1', '--space-8', '--radius-pill', '--shadow-2', '--font-sans', '--text-hero', '--z-toast', '--dur-base', '--ease-out', '--focus-ring', '--motion-scale', '--grad-scrim-bottom']) assert.ok(tokens.includes(t + ':'), t);
});

test('fonte Inter embutida: arquivo e licença no projeto, @font-face aponta para ele, tamanho pequeno', () => {
  const base = read('../styles/base.css');
  assert.match(base, /font-family: "Inter";/); assert.match(base, /font-display: swap;/);
  assert.ok(exists('../assets/fonts/inter-latin-wght-normal.woff2'));
  assert.ok(statSync(new URL('../assets/fonts/inter-latin-wght-normal.woff2', import.meta.url)).size < 120000);
  assert.match(read('../assets/fonts/INTER-LICENSE-OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/i);
  const bytes = readFileSync(new URL('../assets/fonts/inter-latin-wght-normal.woff2', import.meta.url));
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', 'é um woff2 de verdade');
  assert.match(read('../../THIRD-PARTY-NOTICES.md'), /\*\*Inter\*\*/); assert.match(read('../../docs/midia/CREDITOS.md'), /Inter/);
});

test('página: estilos, fonte e movimento carregam antes da primeira pintura; Perfil tem o seletor com 4 opções', () => {
  const html = read('../index.html');
  const iStyle = html.indexOf('<style>');
  for (const part of ['rel="preload" as="font"', 'href="styles/tokens.css"', 'href="styles/base.css"', 'href="styles/motion.css"', '<script src="server/motion.js"></script>']) {
    const at = html.indexOf(part); assert.ok(at > 0 && at < iStyle, part + ' antes do <style>');
  }
  const sel = /<select id="motion-select"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(sel); assert.deepEqual([...sel[1].matchAll(/value="([a-z]+)"/g)].map((m) => m[1]), M.CHOICES);
  assert.match(html, /<p id="motion-note" role="status">/);
});

// ---------- pacote de mídia ----------
const manifest = JSON.parse(read('../media/manifest.json'));

test('manifesto de mídia: válido, com licença e crédito em tudo, e cada arquivo existe', () => {
  assert.deepEqual(Media.validateManifest(manifest), []);
  assert.equal(manifest.items.length, 7);
  assert.deepEqual([...new Set(manifest.items.map((i) => i.category))].sort(), ['amigos', 'aventura', 'cinema', 'cozy', 'ficcao-cientifica', 'noite', 'romance']);
  for (const it of manifest.items) assert.ok(exists('../media/' + it.file), it.file);
  const files = readdirSync(new URL('../media/', import.meta.url)).filter((f) => f !== 'manifest.json');
  assert.deepEqual(files.sort(), manifest.items.map((i) => i.file).sort(), 'não sobra arquivo fora do manifesto');
});

test('manifesto: cada problema é detectado', () => {
  const ok = manifest.items[0];
  const bad = (patch) => Media.validateManifest({ v: 1, items: [{ ...ok, ...patch }] });
  assert.ok(bad({ license: '' }).some((p) => /license/.test(p)));
  assert.ok(bad({ credit: undefined }).some((p) => /credit/.test(p)));
  assert.ok(bad({ source: 'ab' }).some((p) => /source/.test(p)));
  assert.ok(bad({ alt: '' }).some((p) => /alt/.test(p)));
  assert.ok(bad({ category: 'politica' }).some((p) => /categoria/.test(p)));
  assert.ok(bad({ file: '../x.svg' }).some((p) => /arquivo/.test(p)));
  assert.ok(bad({ file: 'a/b.svg' }).some((p) => /arquivo/.test(p)));
  assert.ok(bad({ color: 'red' }).some((p) => /cor/.test(p)));
  assert.ok(bad({ type: 'gif' }).some((p) => /tipo/.test(p)));
  assert.ok(bad({ width: 10 }).some((p) => /tamanho/.test(p)));
  assert.ok(bad({ id: 'A B' }).some((p) => /id inválido/.test(p)));
  assert.ok(Media.validateManifest({ v: 1, items: [ok, ok] }).some((p) => /repetido/.test(p)));
  for (const m of [null, {}, { v: 2, items: [] }, { v: 1 }, { v: 1, items: 'x' }]) assert.ok(Media.validateManifest(m).length > 0);
});

test('ilustrações: leves, acessíveis e sem nada executável nem recurso externo', () => {
  for (const it of manifest.items) {
    const svg = read('../media/' + it.file);
    assert.ok(Buffer.byteLength(svg) < 20000, it.file + ' pesado');
    assert.match(svg, /^<svg [^>]*viewBox="0 0 1920 1080"/); assert.match(svg, /role="img"/); assert.match(svg, /aria-label="[^"]{10,}"/);
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|xlink:href|href="http|javascript:|onload=|@import|url\(http/i, it.file);
  }
});

test('escolha de mídia: respeita a categoria, evita as últimas e nunca fica sem resposta', () => {
  const m = { v: 1, items: ['a', 'b', 'c', 'd'].map((id) => ({ ...manifest.items[0], id, category: 'noite' })).concat({ ...manifest.items[0], id: 'solo', category: 'cozy' }) };
  assert.equal(Media.pick(m, 'inexistente'), null);
  assert.equal(Media.pick(m, 'cozy').id, 'solo');
  assert.equal(Media.pick(m, 'cozy', { recent: ['solo'] }).id, 'solo', 'categoria com um só item repete, em vez de falhar');
  assert.ok(!['a', 'b', 'c'].includes(Media.pick(m, 'noite', { recent: ['a', 'b', 'c'] }).id), 'evita as 3 últimas');
  assert.equal(Media.pick(m, 'noite', { recent: ['a', 'b', 'c'] }).id, 'd');
  assert.notEqual(Media.pick(m, 'noite', { recent: ['a', 'b', 'c', 'd'], rng: () => 0 }).id, 'd', 'se todas foram vistas, só evita a última');
  let recent = [], last = null;
  for (let i = 0; i < 60; i++) { const it = Media.pick(m, 'noite', { recent, rng: () => (i * 0.37) % 1 }); assert.notEqual(it.id, last, 'nunca a mesma duas vezes seguidas'); last = it.id; recent = Media.remember(recent, it.id); }
  assert.ok(recent.length <= Media.REMEMBER * 2);
  assert.equal(Media.urlOf({ file: 'noite.svg' }), '/media/noite.svg');
});

// ---------- entrega e empacotamento ----------
test('o serviço entrega os arquivos novos com o tipo certo e recusa o que não está na lista', async () => {
  const svc = createRoomService({ servePrototype: true });
  const addr = await svc.listen(0, '127.0.0.1');
  const get = (p) => fetch(`http://127.0.0.1:${addr.port}${p}`);
  try {
    for (const [p, type] of [['/styles/tokens.css', 'text/css'], ['/styles/base.css', 'text/css'], ['/styles/motion.css', 'text/css'], ['/server/motion.js', 'text/javascript'], ['/src/media.js', 'text/javascript'], ['/media/manifest.json', 'application/json'], ['/media/noite.svg', 'image/svg+xml'], ['/assets/fonts/inter-latin-wght-normal.woff2', 'font/woff2']]) {
      const r = await get(p);
      assert.equal(r.status, 200, p); assert.ok(r.headers.get('content-type').startsWith(type), p + ' ' + r.headers.get('content-type'));
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      await r.arrayBuffer();
    }
    for (const p of ['/media/nao-existe.svg', '/media/sub/a.svg', '/media/..%2findex.html', '/media/a.exe', '/media/A.SVG', '/assets/fonts/x.ttf', '/assets/fonts/inter-latin-wght-normal.woff', '/styles/outro.css']) {
      const r = await get(p); assert.equal(r.status, 404, p); await r.arrayBuffer();
    }
  } finally { await svc.close(); }
});

test('empacotamento: Windows e macOS levam estilos e mídia para dentro do app', () => {
  assert.match(read('../../app/scripts/build-windows.ps1'), /foreach \(\$section in 'assets', 'data', 'media', 'server', 'src', 'styles'\)/);
  assert.match(read('../../app/scripts/build-macos-app.sh'), /for section in assets data media server src styles; do/);
});
