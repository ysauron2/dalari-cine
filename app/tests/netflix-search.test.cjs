'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { netflixSearchUrl, netflixNavigationAllowed } = require('../src/url-policy.cjs');
const NUL = String.fromCharCode(0);

test('busca da Netflix: só texto, com o nome codificado e sem lixo; nunca outro endereço', () => {
  assert.equal(netflixSearchUrl('A Era do Gelo 4'), 'https://www.netflix.com/search?q=A%20Era%20do%20Gelo%204');
  assert.equal(netflixSearchUrl('  Tom & Jerry  '), 'https://www.netflix.com/search?q=Tom%20%26%20Jerry');
  assert.equal(netflixSearchUrl('a' + NUL + 'b\nc'), 'https://www.netflix.com/search?q=a%20b%20c');
  assert.equal(netflixSearchUrl('x'.repeat(300)), 'https://www.netflix.com/search?q=' + 'x'.repeat(100));
  const evil = new URL(netflixSearchUrl('https://evil.example/&q=1#frag'));
  assert.equal(evil.origin, 'https://www.netflix.com');
  assert.equal(evil.pathname, '/search');
  assert.equal(evil.hash, '', 'o texto não vira âncora');
  assert.equal(evil.searchParams.get('q'), 'https://evil.example/&q=1#frag', 'tudo fica dentro de um único parâmetro');
  assert.deepEqual([...evil.searchParams.keys()], ['q']);
  for (const bad of ['', '   ', null, undefined, 5, {}, []]) assert.equal(netflixSearchUrl(bad), null);
  assert.equal(netflixNavigationAllowed(netflixSearchUrl('qualquer')), true, 'a janela da Netflix aceita o endereço gerado');
});

test('o processo principal só aceita o pedido de busca vindo da interface do Dalari Cine', () => {
  const fs = require('node:fs'), path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /const acceptNetflixSearch = \(event, title\) => \{\s*const url = fromDuo\(event\) \? netflixSearchUrl\(title\) : null;/);
  assert.match(main, /ipcMain\.removeListener\('duotela:netflix-search', acceptNetflixSearch\)/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'duotela-preload.cjs'), 'utf8');
  assert.match(preload, /openNetflixSearch: title => \{ if \(typeof title === 'string' && title\.length <= 200\)/);
});
