import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DuoRoomClient } = require('../server/client.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('cliente: um pedido pendurado desiste no prazo, em vez de prender a tela para sempre', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('abortado'), { name: 'AbortError' }))));
  const client = new DuoRoomClient({ serviceUrl: 'http://127.0.0.1:9', fetchImpl: hang, requestTimeoutMs: 60 });
  const t0 = Date.now();
  await assert.rejects(client.createRoom('Ana'), (e) => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 1500, 'desistiu em ' + (Date.now() - t0) + ' ms');
});

test('cliente: a espera longa da sala não recebe o limite curto (ela tem o próprio sinal)', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = init.signal; return new Response(JSON.stringify({ ok: true, hostToken: 't'.repeat(43), code: '123456', inviteSecret: 'A'.repeat(43), inviteExpiresAt: 1, roomExpiresAt: 2 }), { status: 200 }); };
  const client = new DuoRoomClient({ serviceUrl: 'http://127.0.0.1:9', fetchImpl, requestTimeoutMs: 5000 });
  await client.createRoom('Ana');
  assert.ok(seen, 'os pedidos comuns levam um sinal de prazo');
});

test('tela: sair e fechar a sala sempre terminam localmente; chamadas penduradas têm prazo', () => {
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes("if (act === 'leave') return void exitRoom(false);"));
  assert.ok(ui.includes('return void exitRoom(true);'));
  // não passam por run(): o travamento de outra ação não pode impedir a saída
  assert.doesNotMatch(ui, /if \(act === 'leave'\) return void run\(/);
  assert.match(ui, /async function exitRoom\(forEveryone\) \{[\s\S]*?withTimeout\(forEveryone \? client\.closeRoom\(\) : client\.leaveRoom\(\), 6000[\s\S]*?\} catch \{ \/\* o resto da saída é local \*\/ \}[\s\S]*?finally \{ exiting = false; busy = false;[\s\S]*?disconnect\(\);/);
  assert.ok(ui.includes('const RUN_TIMEOUT_MS = 30000;'));
  assert.ok(ui.includes("await withTimeout(task(), RUN_TIMEOUT_MS, 'Demorou demais para responder. Tente de novo.');"));
});

test('painel da sala some de verdade ao sair (o atributo hidden não pode perder para o display:grid) e o menu não desfaz a confirmação de fechar', () => {
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes('.rv3{display:grid;gap:18px;min-width:0}\n    .rv3[hidden]{display:none}'));
  // o clique que arma "Fechar sala" troca o botão; o caminho do clique (composedPath) evita tratá-lo como clique fora do menu
  assert.match(ui, /const inside = \(typeof e\.composedPath === 'function' \? e\.composedPath\(\) : \[\]\)\.some\(\(n\) => n\.classList\?\.contains\('rv3-menuwrap'\)\)/);
  assert.doesNotMatch(ui, /document\.addEventListener\('click', \(e\) => \{ if \(!menu\.hidden && !e\.target\.closest\?\.\('\.rv3-menuwrap'\)\) setMenu\(false\); \}\);/);
});

test('pareamento: conexão direta que não abre (ICE) conta como "link"; "join" só quando a sala recusa o pedido', () => {
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes("if (short) tel?.event('pair_fail', e && e.name === 'RoomError' ? 'join' : 'link');"));
  assert.doesNotMatch(ui, /pair_fail', e\.message === 'timeout' \? 'link' : 'join'/);
  assert.match(read('../../stats-worker/src/format.js'), /link: 'a conexão direta não abriu', join: 'a sala recusou o pedido'/);
});
