'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { netflixNavigationAllowed, parseDuoTelaUrl, sameDuoTelaOrigin, insecureOriginToTreatAsSecure } =require('../src/url-policy.cjs');
const { workspaceBounds } = require('../src/layout.cjs');

test('Netflix aceita apenas HTTPS em domínio Netflix real', () => {
  assert.equal(netflixNavigationAllowed('https://www.netflix.com/watch/123'), true);
  assert.equal(netflixNavigationAllowed('https://auth.netflix.com/login'), true);
  for (const bad of ['http://www.netflix.com/', 'https://netflix.com.evil.test/', 'https://evil.test/netflix.com', 'https://user:pass@www.netflix.com/', 'https://www.netflix.com:444/', 'javascript:alert(1)']) {
    assert.equal(netflixNavigationAllowed(bad), false, bad);
  }
});

test('Dalari Cine aceita somente serviço HTTP local sem credenciais na URL', () => {
  const url = parseDuoTelaUrl('http://127.0.0.1:8787/');
  assert.equal(url.origin, 'http://127.0.0.1:8787');
  assert.equal(sameDuoTelaOrigin('http://127.0.0.1:8787/sala', url.origin), true);
  assert.equal(sameDuoTelaOrigin('http://127.0.0.1:8797/', url.origin), false);
  for (const bad of ['https://example.com/', 'http://192.168.1.3:8787/', 'http://user:pass@localhost:8787/', 'http://localhost:8787/?token=abc', 'file:///C:/Users/file']) {
    assert.throws(() => parseDuoTelaUrl(bad), undefined, bad);
  }
});

test('LAN é opt-in: sem allowLan o IPv4 privado continua recusado', () => {
  assert.throws(() => parseDuoTelaUrl('http://192.168.0.181:8798/'), /DUOTELA_ALLOW_LAN/);
  assert.throws(() => parseDuoTelaUrl('http://192.168.0.181:8798/', { allowLan: false }));
});

test('allowLan aceita só HTTP em IPv4 privado (RFC 1918) sem credenciais, consulta ou fragmento', () => {
  for (const good of ['http://192.168.0.181:8798/', 'http://10.0.0.5:8787/', 'http://172.16.0.1:8787/', 'http://172.31.255.254:8787/', 'http://127.0.0.1:8787/', 'http://localhost:8787/']) {
    assert.doesNotThrow(() => parseDuoTelaUrl(good, { allowLan: true }), good);
  }
  for (const bad of ['http://172.32.0.1:8787/', 'http://172.15.0.1:8787/', 'http://192.169.0.1:8787/', 'http://8.8.8.8:8787/', 'http://169.254.1.1:8787/', 'http://192.168.0.256:8787/', 'http://meu-pc.local:8787/', 'http://[fd00::1]:8787/', 'https://192.168.0.181:8798/', 'http://user:pass@192.168.0.181:8798/', 'http://192.168.0.181:8798/?t=1', 'http://192.168.0.181:8798/#x', 'http://192.168.0.181.evil.test:8798/']) {
    assert.throws(() => parseDuoTelaUrl(bad, { allowLan: true }), undefined, bad);
  }
});

test('allowRemote é opt-in e aceita só HTTPS (sem credenciais, consulta ou fragmento); HTTP remoto nunca', () => {
  assert.throws(() => parseDuoTelaUrl('https://duotela.example.com/'), /DUOTELA_ALLOW_REMOTE/);
  const url = parseDuoTelaUrl('https://duotela.example.com:8443/sala', { allowRemote: true });
  assert.equal(url.origin, 'https://duotela.example.com:8443');
  assert.equal(insecureOriginToTreatAsSecure(url), null);   // HTTPS já é origem segura: nenhum switch do Chromium
  for (const bad of ['http://duotela.example.com/', 'http://8.8.8.8:8787/', 'https://user:pass@duotela.example.com/', 'https://duotela.example.com/?t=1', 'https://duotela.example.com/#x', 'file:///C:/x', 'ftp://duotela.example.com/']) {
    assert.throws(() => parseDuoTelaUrl(bad, { allowRemote: true }), undefined, bad);
  }
  assert.throws(() => parseDuoTelaUrl('https://duotela.example.com/', { allowLan: true }));   // LAN não abre HTTPS remoto
});

test('só a origem LAN exata é tratada como segura para o microfone; loopback não precisa', () => {
  assert.equal(insecureOriginToTreatAsSecure(parseDuoTelaUrl('http://192.168.0.181:8798/sala', { allowLan: true })), 'http://192.168.0.181:8798');
  assert.equal(insecureOriginToTreatAsSecure(parseDuoTelaUrl('http://127.0.0.1:8787/')), null);
  assert.equal(insecureOriginToTreatAsSecure(null), null);
  assert.equal(sameDuoTelaOrigin('http://192.168.0.181:8799/', 'http://192.168.0.181:8798'), false);
});

test('Dalari Cine ocupa a janela inteira até a sala escolher Netflix', () => {
  for (const [w, h] of [[900, 600], [1280, 800], [1920, 1080]]) {
    for (const platform of [null, 'youtube', 'prime', 'crunchyroll']) {
      const bounds = workspaceBounds(w, h, platform, false);
      assert.deepEqual(bounds.duotela, { x: 0, y: 0, width: w, height: h });
      assert.equal(bounds.toggle, null);
    }
    for (const open of [false, true]) {
      const { duotela, netflix, toggle } = workspaceBounds(w, h, 'netflix', open);
      assert.deepEqual(netflix, { x: 0, y: 0, width: w, height: h });
      assert.equal(duotela.height, h);
      assert.equal(duotela.x, open ? 0 : -duotela.width);
      assert.ok(toggle.x >= 0 && toggle.x + toggle.width <= w);
    }
  }
});
