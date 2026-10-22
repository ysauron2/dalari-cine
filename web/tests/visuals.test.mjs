import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const Icons = require('../server/icons.js');
const Ambient = require('../server/ambient.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('ícones: conjunto completo, SVG válido, nome desconhecido não quebra', () => {
  for (const name of ['home', 'discover', 'heart', 'history', 'room', 'user', 'play', 'pause', 'fullscreen', 'mic', 'headphones', 'check', 'circle', 'invite', 'dots', 'sync', 'film', 'close', 'gear', 'moon', 'sparkle']) {
    assert.ok(Icons.has(name), name);
    const svg = Icons.html(name);
    assert.match(svg, /^<svg class="ico ico-[a-z]+" viewBox="0 0 24 24"/);
    assert.match(svg, /aria-hidden="true"/, 'ícone é decorativo para leitores de tela');
    assert.match(svg, /<path d="[MmLlHhVvCcSsQqTtAaZz0-9 .,\-]+"/, name + ' tem um caminho válido');
    assert.equal(svg.includes('<script'), false);
  }
  assert.equal(Icons.html('nao-existe'), '');
  assert.equal(Icons.node({}, 'nao-existe'), null);
  assert.equal(Icons.has('__proto__'), false);
  assert.equal(Icons.has('constructor'), false);
});

test('"@icone texto": separa o ícone do texto e ignora nomes desconhecidos', () => {
  assert.deepEqual(Icons.split('@play Reproduzir'), { icon: 'play', text: 'Reproduzir' });
  assert.deepEqual(Icons.split('@fullscreen'), { icon: 'fullscreen', text: '' });
  assert.deepEqual(Icons.split('@check Você'), { icon: 'check', text: 'Você' });
  assert.deepEqual(Icons.split('@desconhecido oi'), { icon: null, text: '@desconhecido oi' });
  assert.deepEqual(Icons.split('Sem ícone'), { icon: null, text: 'Sem ícone' });
  assert.deepEqual(Icons.split(undefined), { icon: null, text: '' });
});

test('todo "@icone" usado nos textos da sala existe no conjunto', () => {
  const src = read('../server/online-ui.js');
  const used = new Set([...src.matchAll(/'@([a-z]+)[ ']/g), ...src.matchAll(/\? '@([a-z]+) '/g)].map((m) => m[1]));
  assert.ok(used.size >= 7, 'deve haver vários ícones em uso: ' + [...used]);
  for (const name of used) assert.ok(Icons.has(name), 'ícone usado e não definido: ' + name);
  const html = read('../index.html');
  for (const m of html.matchAll(/\['(?:home|discover|list|history|room|profile)','([a-z]+)'/g)) assert.ok(Icons.has(m[1]), 'ícone do menu: ' + m[1]);
});

test('cor do cartaz: pega a cor viva dominante e ignora preto, branco e cinza', () => {
  const px = (list) => Uint8ClampedArray.from(list.flatMap(([r, g, b]) => [r, g, b, 255]));
  const poster = [...Array(60).fill([200, 40, 50]), ...Array(80).fill([20, 20, 22]), ...Array(40).fill([240, 240, 240]), ...Array(20).fill([110, 110, 115]), ...Array(10).fill([40, 80, 220])];
  const c = Ambient.vibrant(px(poster));
  assert.ok(c.r > 180 && c.g < 70 && c.b < 80, 'vermelho domina: ' + JSON.stringify(c));
  assert.equal(Ambient.vibrant(px([...Array(50).fill([10, 10, 10]), ...Array(50).fill([128, 128, 128]), ...Array(50).fill([250, 250, 250])])), null, 'sem cor viva: null');
  assert.equal(Ambient.vibrant(new Uint8ClampedArray(0)), null);
  const transparent = Uint8ClampedArray.from(Array(100).fill([200, 40, 50, 0]).flat());
  assert.equal(Ambient.vibrant(transparent), null, 'pixels transparentes não contam');
});

test('cor estável por título e ajuste para fundo escuro', () => {
  const a = Ambient.hashColor('tmdb:movie:550'), b = Ambient.hashColor('tmdb:movie:550'), c = Ambient.hashColor('tmdb:movie:551');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const seed of ['x', 'abc', 'tmdb:movie:1', '', undefined, '😀', 'youtube:dQw4w9WgXcQ']) {
    const t = Ambient.tune(Ambient.hashColor(seed));
    for (const ch of [t.r, t.g, t.b]) assert.ok(Number.isInteger(ch) && ch >= 0 && ch <= 255);
    const { s, v } = Ambient.rgbToHsv(t.r, t.g, t.b);
    assert.ok(v >= 0.69 && s >= 0.44, `${seed}: ${JSON.stringify(t)}`);
  }
  const dull = Ambient.tune({ r: 30, g: 30, b: 40 });
  assert.ok(Ambient.rgbToHsv(dull.r, dull.g, dull.b).v >= 0.69, 'cor escura é clareada');
  assert.equal(Ambient.css({ r: 1, g: 2, b: 3 }), 'rgb(1 2 3)');
  assert.equal(Ambient.css({ r: 1, g: 2, b: 3 }, 0.2), 'rgb(1 2 3 / 0.2)');
});

test('colorFor nunca falha: sem imagem ou com imagem ilegível usa a cor estável', async () => {
  const win = { setTimeout, clearTimeout, Image: class { set src(_) { setTimeout(() => this.onerror?.(), 0); } } };
  const a = await Ambient.colorFor(win, { url: 'https://exemplo/x.jpg', seed: 'abc' });
  const b = await Ambient.colorFor(win, { url: '', seed: 'abc' });
  assert.deepEqual(a, b);
});

test('a página e o serviço entregam os módulos visuais; cinema, ambiente e avatar estão ligados', () => {
  const html = read('../index.html'), svc = read('../server/room-service.js'), ui = read('../server/online-ui.js'), voice = read('../server/voice.js');
  for (const f of ['icons', 'ambient']) {
    assert.match(html, new RegExp(`<script src="server/${f}\\.js"></script>`));
    assert.match(svc, new RegExp(`'/server/${f}\\.js', 'server/${f}\\.js'`));
  }
  assert.match(ui, /cinema-on/);
  assert.match(ui, /:where\(:root\[data-motion="reduced"\],:root\[data-motion="off"\]\) \.avatar,:where\(:root\[data-motion="reduced"\],:root\[data-motion="off"\]\) \.avatar\.is-incall\{animation:none!important/,'avatar respira respeita "reduzir movimento"');
  assert.match(ui, /onLevels: \(l\) => onVoiceLevels\(l\)/);
  assert.match(voice, /this\.onLevels\(\{ \.\.\.levels \}\)/);
  assert.match(read('../server/first-run.js'), /wl-hero/);
});
