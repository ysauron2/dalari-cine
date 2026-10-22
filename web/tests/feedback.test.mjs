import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const F = require('../server/feedback.js');

const URL_OK = 'https://dalari-stats.exemplo.workers.dev';
const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('valida o que a pessoa escreveu antes de enviar', () => {
  assert.deepEqual(F.validate({ kind: 'ideia', message: 'Fila de vídeos seria ótimo' }), { ok: true });
  assert.equal(F.validate({ kind: 'xss', message: 'oi tudo bem' }).reason, 'kind');
  assert.equal(F.validate({ kind: 'ideia', message: '  ' }).reason, 'empty');
  assert.equal(F.validate({ kind: 'ideia', message: 'oi' }).reason, 'empty');
  assert.equal(F.validate({ kind: 'ideia' }).reason, 'empty');
  assert.equal(F.validate({ kind: 'ideia', message: 'x'.repeat(F.MAX_MESSAGE + 1) }).reason, 'too_long');
  assert.deepEqual(F.validate({ kind: 'ideia', message: 'x'.repeat(F.MAX_MESSAGE) }), { ok: true });
  assert.equal(F.validate({ kind: 'ideia', message: 'texto ok', contact: 'c'.repeat(F.MAX_CONTACT + 1) }).reason, 'contact_long');
});

test('o corpo enviado tem só o necessário; versão e sistema só se a pessoa deixou marcado', () => {
  const env = { version: '0.3.1', os: 'mac' };
  assert.deepEqual(F.buildPayload({ kind: 'problema', message: '  A voz caiu  ', contact: '', includeInfo: true }, env), { v: 1, kind: 'problema', message: 'A voz caiu', app: '0.3.1', os: 'mac' });
  assert.deepEqual(F.buildPayload({ kind: 'problema', message: 'A voz caiu', contact: ' a@b.com ', includeInfo: false }, env), { v: 1, kind: 'problema', message: 'A voz caiu', contact: 'a@b.com' }, 'sem marcar, nada de versão/sistema');
  assert.deepEqual(F.buildPayload({ kind: 'elogio', message: 'Amei', includeInfo: true }, { version: 'dev', os: 'beos' }), { v: 1, kind: 'elogio', message: 'Amei' }, 'valores inválidos ou "dev" não vão');
  const p = F.buildPayload({ kind: 'outro', message: 'oi tudo', contact: 'x', includeInfo: true }, env);
  assert.deepEqual(Object.keys(p).sort(), ['app', 'contact', 'kind', 'message', 'os', 'v'], 'nunca inclui o identificador da instalação');
});

test('envio: endereço certo, texto simples (sem preflight), sem cookies nem referrer', async () => {
  F.resetCooldown();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return reply(200, { ok: true }); };
  const r = await F.send({ v: 1, kind: 'ideia', message: 'Fila de vídeos' }, { url: URL_OK + '/', fetchImpl, now: 1_000_000 });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0].url, URL_OK + '/v1/feedback');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers['Content-Type'], /^text\/plain/);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(calls[0].init.body), { v: 1, kind: 'ideia', message: 'Fila de vídeos' });
});

test('envio: respostas de erro viram mensagens claras e o texto da pessoa não se perde', async () => {
  const send = (fetchImpl, now) => F.send({ v: 1, kind: 'ideia', message: 'texto' }, { url: URL_OK, fetchImpl, now });
  F.resetCooldown(); assert.equal((await F.send({ v: 1 }, { url: '', fetchImpl: async () => reply(200), now: 1 })).reason, 'unavailable');
  F.resetCooldown(); assert.equal((await F.send({ v: 1 }, { url: URL_OK, fetchImpl: null, now: 1 })).reason, 'unavailable');
  F.resetCooldown(); assert.equal((await send(async () => reply(429, { error: 'rate_limited' }), 10_000_000)).reason, 'rate_limited');
  F.resetCooldown(); assert.equal((await send(async () => reply(429, { error: 'daily_limit' }), 10_000_000)).reason, 'daily_limit');
  F.resetCooldown(); assert.equal((await send(async () => reply(502, { error: 'delivery' }), 10_000_000)).reason, 'server');
  F.resetCooldown(); assert.equal((await send(async () => reply(400, {}), 10_000_000)).reason, 'server');
  F.resetCooldown(); assert.equal((await send(async () => { throw new TypeError('Failed to fetch'); }, 10_000_000)).reason, 'network');
  F.resetCooldown(); assert.equal((await send(async () => ({ ok: false, status: 500, json: async () => { throw new Error('sem corpo'); } }), 10_000_000)).reason, 'server');
  for (const reason of ['empty', 'too_long', 'contact_long', 'kind', 'unavailable', 'too_soon', 'rate_limited', 'daily_limit', 'network', 'server']) {
    assert.ok(F.friendly(reason).length > 10, reason);
  }
  assert.equal(F.friendly('qualquer-coisa'), F.MESSAGES.server);
});

test('depois de um envio, outro só passa depois de 30 segundos; falhas não travam', async () => {
  F.resetCooldown();
  let n = 0;
  const ok = async () => { n++; return reply(200); };
  const send = (now, fetchImpl = ok) => F.send({ v: 1, kind: 'ideia', message: 'texto' }, { url: URL_OK, fetchImpl, now });
  assert.equal((await send(100_000)).ok, true);
  assert.equal((await send(100_000 + 5_000)).reason, 'too_soon');
  assert.equal(n, 1, 'a segunda nem chega à rede');
  assert.equal((await send(100_000 + F.COOLDOWN_MS)).ok, true);
  F.resetCooldown();
  assert.equal((await send(500_000, async () => { throw new Error('rede'); })).reason, 'network');
  assert.equal((await send(500_001)).ok, true, 'depois de uma falha dá para tentar logo de novo');
});

test('a página carrega o módulo, o botão existe em Perfil, o serviço o entrega e a política fala disso', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="server\/feedback\.js"><\/script>/);
  assert.match(html, /data-duo-open="feedback"/);
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/server\/feedback\.js', 'server\/feedback\.js'/);
  const { POLICY } = require('../server/first-run.js');
  const sec = POLICY.find(([h]) => /feedback/i.test(h));
  assert.ok(sec, 'a política tem a seção de feedback');
  assert.match(sec[1], /não guarda o texto/);
  assert.match(sec[1], /Telegram/);
  assert.match(readFileSync(new URL('../../PRIVACIDADE.md', import.meta.url), 'utf8'), /Mensagens de feedback/, 'PRIVACIDADE.md foi regenerado');
});

test('relatório de problema: texto pronto com o que o app viu; códigos desconhecidos são ignorados', () => {
  const at = new Date(2026, 9, 22, 21, 5).getTime();
  const t = F.problemReport('room_lost', at);
  assert.match(t, /^O app avisou que a sala caiu e não voltou \(às 21:05\)\./);
  assert.match(t, /O que eu estava fazendo: $/);
  assert.equal(F.problemReport('xss<script>', at), '');
  assert.equal(F.problemReport('__proto__', at), '');
  assert.equal(F.problemLabel('constructor'), null);
  assert.ok(F.validate({ kind: 'problema', message: t.trim() }).ok, 'o texto pronto já é um envio válido');
  for (const code of ['player_fail', 'room_lost', 'update_fail', 'unexpected', 'mic_denied', 'mic_missing', 'mic_busy', 'mic_insecure']) assert.ok(F.problemLabel(code), code);
});

test('os pontos onde o app percebe problemas chamam o aviso, e há botão de sugestão sempre à mão', () => {
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.equal((ui.match(/tel\?\.event\('app_error'/g) || []).length, 1, 'só o helper chama o evento direto');
  assert.ok((ui.match(/noteProblem\(/g) || []).length >= 5);
  assert.match(ui, /window\.DuoFeedback\?\.problem\?\.\(code\)/);
  assert.match(readFileSync(new URL('../server/updates-ui.js', import.meta.url), 'utf8'), /DuoFeedback\?\.problem\?\.\('update_fail'\)/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /class="side-feedback" data-duo-open="feedback"/);
});
