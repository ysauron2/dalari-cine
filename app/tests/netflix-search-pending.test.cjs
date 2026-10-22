'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');

test('Procurar na Netflix: a busca espera a janela da Netflix existir (só aparece com a sala em modo Netflix)', () => {
  assert.match(main, /let pendingNetflixSearch = null;/);
  // pedido: se a sala já está em modo Netflix, abre agora; senão guarda
  assert.match(main, /if \(roomPlatform === 'netflix'\) netflixView\.webContents\.loadURL\(url\)\.catch\(\(\) => \{\}\);\s*else pendingNetflixSearch = url;/);
  // ao entrar em modo Netflix: a busca guardada abre no lugar da página inicial
  assert.match(main, /if \(pendingNetflixSearch\) \{\s*const search = pendingNetflixSearch;\s*pendingNetflixSearch = null;\s*netflixLoaded = true;\s*netflixView\.webContents\.loadURL\(search\)/);
  assert.match(main, /\} else if \(!netflixLoaded\) \{\s*netflixLoaded = true;\s*netflixView\.webContents\.loadURL\(NETFLIX_URL\)/);
  // sair do modo Netflix descarta o pedido que não chegou a abrir
  assert.match(main, /panelOpen = false;\s*pendingNetflixSearch = null;/);
});

test('Procurar na Netflix: continua aceitando o pedido só da interface do Dalari Cine, com o endereço montado no processo principal', () => {
  assert.match(main, /const url = fromDuo\(event\) \? netflixSearchUrl\(title\) : null;\s*if \(!url \|\| netflixView\.webContents\.isDestroyed\(\)\) return;/);
});
