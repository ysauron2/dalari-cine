import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const R = require('../server/p2p-rendezvous.js');
const { normalizeJoinCode } = require('../../app/src/url-policy.cjs');

test('link do convite: https com o código só depois do "#"', () => {
  assert.equal(R.inviteLink('k7qm93xp'), 'https://ysauron2.github.io/dalari-cine/entrar/#K7QM-93XP');
  assert.equal(R.inviteLink('K7QM-93XP'), R.inviteLink(' k7qm 93xp '));
  assert.equal(R.inviteLink('curto'), null); assert.equal(R.inviteLink(null), null);
  const url = new URL(R.inviteLink('K7QM-93XP'));
  assert.equal(url.search, '', 'nada na parte que vai ao servidor'); assert.equal(url.pathname, '/dalari-cine/entrar/'); assert.equal(url.hash, '#K7QM-93XP');
});

test('mensagem pronta: link, código para digitar, validade e onde baixar; nome do Host escapado de lixo', () => {
  const m = R.inviteMessage('K7QM-93XP', 'Daniel');
  assert.match(m, /^Daniel te chamou para ver um filme juntos no Dalari Cine! /);
  assert.ok(m.includes('Toque para entrar: https://ysauron2.github.io/dalari-cine/entrar/#K7QM-93XP'));
  assert.ok(m.includes('o código é K7QM-93XP (vale 15 minutos)'));
  assert.ok(m.includes('https://github.com/ysauron2/dalari-cine/releases/latest'));
  assert.match(R.inviteMessage('K7QM-93XP', ''), /^Te chamaram para ver/);
  assert.match(R.inviteMessage('K7QM-93XP', undefined), /^Te chamaram para ver/);
  assert.match(R.inviteMessage('K7QM-93XP', 'x'.repeat(100)), /^x{32} te chamou/);
  assert.equal(R.inviteMessage('inválido'), null);
});

test('as três cópias da regra do código (app web, processo principal e página de entrada) concordam', () => {
  const page = readFileSync(new URL('../../docs/entrar/index.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
  const run = (hash) => {
    const els = {};
    const el = (id) => (els[id] ||= { hidden: true, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
    const ctx = { location: { hash, href: '' }, document: { getElementById: el }, setTimeout: (fn) => { ctx.timer = fn; }, decodeURIComponent, String };
    vm.runInNewContext(script, ctx);
    return { code: els.code?.textContent || null, open: els.open?.attrs.href || null, withCode: els['with-code'].hidden === false, noCode: els['no-code'].hidden === false, ctx };
  };
  const inputs = ['K7QM-93XP', 'k7qm93xp', ' k7qm 93xp ', 'O1L0-IIOO', 'K7QM-93XU', 'K7QM', '', 'ABCDEFGH', 'abcd-efgh', '12345678', '0000-0000', 'ZZZZ-ZZZZ', 'UUUU-UUUU', 'K7QM-93XP-', 'K7QM_93XP'];
  for (const text of inputs) {
    const expected = R.normalizeCode(text) === null ? null : R.normalizeCode(text).slice(0, 4) + '-' + R.normalizeCode(text).slice(4);
    assert.equal(normalizeJoinCode(text), expected, 'app: ' + JSON.stringify(text));
    const page1 = run('#' + encodeURIComponent(text));
    assert.equal(page1.code, expected, 'página: ' + JSON.stringify(text));
    assert.equal(page1.withCode, expected !== null); assert.equal(page1.noCode, expected === null);
    if (expected) assert.equal(page1.open, 'dalari://entrar/' + expected);
  }
  const ok = run('#K7QM-93XP');
  assert.equal(typeof ok.ctx.timer, 'function', 'tenta abrir o app uma vez, sem insistir');
  ok.ctx.timer(); assert.equal(ok.ctx.location.href, 'dalari://entrar/K7QM-93XP');
  assert.equal(run('').ctx.timer, undefined, 'sem código não tenta abrir nada');
});

test('página de entrada: sem rastreamento nem recursos externos, política de conteúdo fechada, link de download do projeto', () => {
  const page = readFileSync(new URL('../../docs/entrar/index.html', import.meta.url), 'utf8');
  assert.match(page, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+href=|<img|@import|url\(|fetch\(|XMLHttpRequest|analytics|gtag/i);
  assert.match(page, /https:\/\/github\.com\/ysauron2\/dalari-cine\/releases\/latest/);
  assert.match(page, /textContent = code/, 'o código entra como texto, nunca como HTML');
  assert.doesNotMatch(page, /innerHTML/);
});

test('a tela do Host copia o convite com link e a do convidado entra pelo link recebido', () => {
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /copyText\(R\.inviteMessage\(code, adapter\.getProfileName\(\)\)/);
  assert.match(ui, /'short-copy-invite'/);
  assert.match(ui, /window\.duoDesktop\?\.onJoinLink\?\.\(\(code\) => joinFromLink\(code\)\)/);
  assert.match(ui, /await shortJoin\(code, name\)/);
});
