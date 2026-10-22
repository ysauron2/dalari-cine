'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isAllowedExternal, ALLOWED } = require('../src/external-links.cjs');

test('só os endereços da lista fechada abrem no navegador', () => {
  for (const bad of ['https://github.com/ysauron2/', 'https://github.com/ysauron2/outro', 'http://github.com/ysauron2', 'https://evil.example/', 'file:///C:/x', 'javascript:alert(1)', 'https://github.com/ysauron2@evil.example', '', null, undefined, 5, {}]) {
    assert.equal(isAllowedExternal(bad), false, String(bad));
  }
  for (const ok of ALLOWED) assert.equal(isAllowedExternal(ok), true);
});

test('os links mostrados em "Sobre e créditos" são exatamente os permitidos (quando a pasta web existe)', (t) => {
  const file = path.join(__dirname, '..', '..', 'web', 'server', 'first-run.js');
  if (!fs.existsSync(file)) return t.skip('pasta web ausente');
  const { LINKS } = require(file);
  assert.deepEqual([...Object.values(LINKS)].sort(), [...ALLOWED].sort());
});
