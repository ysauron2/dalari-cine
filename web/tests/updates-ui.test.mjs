import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { describe } = require('../server/updates-ui.js');

const base = { enabled: true, current: '0.1.0', auto: true, progress: 0, message: '' };

test('versão nova mostra aviso com os botões Atualizar e Depois, e "Depois" some só para essa versão', () => {
  const s = { ...base, status: 'available', version: '0.2.0' };
  const d = describe(s, null);
  assert.match(d.line, /0\.2\.0/);
  assert.match(d.line, /0\.1\.0/);
  assert.deepEqual(d.toast.actions, ['install', 'later']);
  assert.match(d.toast.sub, /fecha o app/, 'avisa que atualizar encerra a sala e a chamada');
  assert.equal(d.canInstall, true);
  assert.equal(describe(s, '0.2.0').toast, null, 'dispensado: sem aviso, mas o botão em Perfil continua');
  assert.equal(describe(s, '0.2.0').canInstall, true);
  assert.ok(describe(s, '0.1.5').toast, 'uma versão ainda mais nova volta a avisar');
});

test('baixando mostra porcentagem limitada a 0..100 e bloqueia verificar', () => {
  const d = describe({ ...base, status: 'downloading', version: '0.2.0', progress: 0.456 }, null);
  assert.match(d.toast.text, /46%/);
  assert.equal(d.canCheck, false);
  assert.match(describe({ ...base, status: 'downloading', version: '0.2.0', progress: 7 }, null).line, /100%/);
  assert.match(describe({ ...base, status: 'downloading', version: '0.2.0', progress: -1 }, null).line, / 0%/);
});

test('erro de instalação avisa; erro ao verificar fica só na linha de Perfil', () => {
  const install = describe({ ...base, status: 'error', message: 'Falha ao atualizar: o arquivo baixado não confere com o esperado' }, null);
  assert.ok(install.toast);
  assert.deepEqual(install.toast.actions, ['close']);
  const check = describe({ ...base, status: 'error', message: 'Não foi possível verificar: servidor respondeu 500' }, null);
  assert.equal(check.toast, null);
  assert.match(check.line, /verificar/);
});

test('sem configuração nada é oferecido; estado inválido não quebra', () => {
  const off = describe({ ...base, enabled: false, status: 'disabled' }, null);
  assert.equal(off.canCheck, false);
  assert.match(off.line, /não estão configuradas/);
  for (const bad of [null, undefined, 'x', 5]) assert.deepEqual(describe(bad, null), { line: '', toast: null, canCheck: false, canInstall: false });
});

test('Mac: depois de abrir o instalador, mostra a instrução em vez de reiniciar', () => {
  const d = describe({ ...base, status: 'ready', manual: true, message: 'Instalador aberto: arraste o Dalari Cine para Aplicativos e substitua o antigo.' }, null);
  assert.match(d.toast.sub, /Aplicativos/);
  assert.deepEqual(d.toast.actions, ['close']);
});

test('a página carrega o script e o serviço da sala o entrega', () => {
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<script src="server\/updates-ui\.js"><\/script>/);
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/server\/updates-ui\.js', 'server\/updates-ui\.js'/);
});

test('versão obrigatória: avisa que criar e entrar em salas está bloqueado, com botão de atualizar quando há instalador', () => {
  const s = { ...base, current: '0.4.1', status: 'available', version: '0.4.3', required: true };
  const d = describe(s, '0.4.3');
  assert.match(d.line, /Atualização necessária/);
  assert.match(d.line, /não cria nem entra em salas/);
  assert.ok(d.toast && d.toast.actions.join() === 'install', 'aviso fixo: não some com "Depois"');
  assert.equal(d.canInstall, true);
  const idle = describe({ ...base, current: '0.4.1', status: 'idle', required: true }, null);
  assert.ok(idle.toast && idle.toast.actions.length === 0 && idle.canInstall === false);
  assert.equal(describe({ ...base, status: 'current', required: false }, null).toast, null);
});

test('salas: criar, entrar e gerar código passam pela checagem de versão mínima, que nunca tranca sem resposta', () => {
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /async function mustUpdate\(\)/);
  assert.match(ui, /setTimeout\(\(\) => resolve\(null\), 5000\)/);
  for (const act of ['create', 'join']) {
    const at = ui.indexOf(`if (act === '${act}') return void run(async () => {`);
    assert.ok(at > 0, act);
    assert.ok(ui.slice(at, at + 160).includes('if (await mustUpdate()) return;'), `${act} checa a versão mínima antes de qualquer outra coisa`);
  }
  assert.ok(ui.includes("if (act === 'short-offer') return void run(async () => { if (await mustUpdate()) return; await shortOffer(); });"));
});

test('Netflix: o aviso "seek-unavailable" tem texto na sala', () => {
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes("desktopNetflixState?.status === 'seek-unavailable'"));
  assert.ok(ui.includes('Play e pausa seguem sincronizados'));
});
