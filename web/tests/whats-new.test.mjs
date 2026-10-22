import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const W = require('../server/whats-new.js');

test('versões: comparação numérica (0.3.10 vem depois de 0.3.9) e lixo vale zero', () => {
  assert.equal(W.compareVersions('0.3.2', '0.3.10'), -1);
  assert.equal(W.compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(W.compareVersions('0.3.3', '0.3.3'), 0);
  assert.equal(W.compareVersions('0.3', '0.3.0'), 0);
  assert.equal(W.compareVersions('x', '0.0.0'), 0);
});

test('o que mudou: só as versões depois da última vista, até a atual, da mais nova para a mais antiga', () => {
  const news = { '0.3.1': [['a', 'A', 'a']], '0.3.2': [['b', 'B', 'b']], '0.3.3': [['c', 'C', 'c']], '0.4.0': [['d', 'D', 'd']] };
  assert.deepEqual(W.entriesSince('0.3.1', '0.3.3', news).map((g) => g.version), ['0.3.3', '0.3.2']);
  assert.deepEqual(W.entriesSince('0.3.3', '0.3.3', news), []);
  assert.deepEqual(W.entriesSince('0.3.2', '0.4.0', news).map((g) => g.version), ['0.4.0', '0.3.3']);
  assert.deepEqual(W.entriesSince(null, '0.3.2', news).map((g) => g.version), ['0.3.2'], 'quem nunca viu a janela parte da versão-base');
  assert.deepEqual(W.entriesSince('lixo', '0.3.3', news).map((g) => g.version), ['0.3.3', '0.3.2']);
  assert.deepEqual(W.entriesSince('0.3.1', 'dev', news), [], 'versão de desenvolvimento não mostra nada');
  assert.deepEqual(W.latestEntries('0.3.3', news, 2).map((g) => g.version), ['0.3.3', '0.3.2']);
  assert.deepEqual(W.latestEntries('0.3.2', news, 1).map((g) => g.version), ['0.3.2']);
});

test('ao abrir: mostra uma vez por versão, nunca para instalação nova nem em desenvolvimento', () => {
  const news = { '0.3.2': [['b', 'B', 'b']], '0.3.3': [['c', 'C', 'c']] };
  const show = W.decide({ current: '0.3.3', lastSeen: '0.3.1', welcomeSeen: true, news });
  assert.equal(show.action, 'show'); assert.equal(show.remember, '0.3.3'); assert.deepEqual(show.groups.map((g) => g.version), ['0.3.3', '0.3.2']);
  assert.deepEqual(W.decide({ current: '0.3.3', lastSeen: '0.3.3', welcomeSeen: true, news }), { action: 'skip', remember: '0.3.3', groups: [] }, 'já viu esta versão');
  assert.deepEqual(W.decide({ current: '0.3.3', lastSeen: null, welcomeSeen: false, news }), { action: 'skip', remember: '0.3.3' }, 'instalação nova: só as boas-vindas');
  assert.deepEqual(W.decide({ current: 'dev', lastSeen: null, welcomeSeen: true, news }), { action: 'skip', remember: null });
  assert.deepEqual(W.decide({ current: null, lastSeen: null, welcomeSeen: true, news }), { action: 'skip', remember: null });
  const none = W.decide({ current: '0.3.4', lastSeen: '0.3.3', welcomeSeen: true, news });
  assert.equal(none.action, 'skip'); assert.equal(none.remember, '0.3.4', 'versão sem novidades listadas: não mostra, mas lembra');
});

test('conteúdo: cada item tem ícone, título e texto curtos, e a versão 0.3.3 e a 0.3.2 estão listadas', () => {
  for (const v of ['0.3.3', '0.3.2']) assert.ok(W.NEWS[v]?.length >= 3, v);
  for (const items of Object.values(W.NEWS)) for (const [icon, title, text] of items) {
    assert.ok(icon && title && text); assert.ok(title.length <= 60, title); assert.ok(text.length <= 170, text.length + ': ' + text);
  }
  assert.ok(Object.keys(W.NEWS).every((v) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)));
});

test('a página carrega a janela, o botão existe em Perfil e o serviço entrega o arquivo', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="server\/whats-new\.js"><\/script>/);
  assert.ok(html.indexOf('server/first-run.js') < html.indexOf('server/whats-new.js'), 'depois das boas-vindas');
  assert.match(html, /data-duo-open="news">O que há de novo/);
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/server\/whats-new\.js', 'server\/whats-new\.js'/);
  const src = readFileSync(new URL('../server/whats-new.js', import.meta.url), 'utf8');
  assert.match(src, /welcomeSeen: !!flag && get\(flag\) === '1'/);
});
