// Teste em navegador real: sair/fechar a sala nunca trava, mesmo com a rede falhando ou com outra ação pendurada.
// Uso: node tools/e2e-exit.mjs
import { createRequire } from 'node:module';
import { launch } from './cdp.mjs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');

const svc = createRoomService({ servePrototype: true, logger: () => {} });
const addr = await svc.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${addr.port}`;
const chrome = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const open = async (matchEnd, behave) => {
    const { browserContextId } = await chrome.browser.send('Target.createBrowserContext');
    const p = await chrome.browser.page(null, { contextId: browserContextId });
    await p.goto(origin + '/');
    await p.evaluate(() => { localStorage.setItem('duotela-welcome-v4', '1'); localStorage.setItem('duotela-audio-wizard-v1', '1'); localStorage.setItem('duotela-telemetry', 'off'); });
    await p.goto(origin + '/');
    await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    // o cliente da sala guarda o fetch ao ser criado: a falha precisa ser instalada ANTES de criar a sala
    if (matchEnd) await p.evaluate((end, how) => { const orig = window.fetch.bind(window); window.fetch = (u, i) => { if (!String(u).endsWith(end)) return orig(u, i); if (how === 'hang') return new Promise(() => {}); if (how === 'network') return Promise.reject(new TypeError('Failed to fetch')); return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'room_closed' }), { status: 409 })); }; }, matchEnd, behave);
    await p.evaluate(() => document.querySelector('[data-view="room"]').click());
    await p.waitFor(() => !!document.querySelector('[data-online-act=create]'));
    await p.evaluate(() => { const n = document.querySelector('#online-display-name'); n.value = 'Ana'; n.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-online-act=create]').click(); });
    await p.waitFor(() => window.DuoTelaOnline.snapshot?.status === 'active');
    return p;
  };
  const active = (p) => p.evaluate(() => window.DuoTelaOnline.active);
  const inLobby = (p) => p.evaluate(() => !!document.querySelector('#online-display-name') && !document.querySelector('#rv3')?.offsetParent);
  const menuAct = async (p, act, times = 1) => {
    for (let i = 0; i < times; i++) {
      await p.evaluate(() => { const b = document.querySelector('#rv3-menu-btn'); if (document.querySelector('#rv3-menu')?.hidden !== false) b.click(); });
      await p.evaluate((a) => document.querySelector(`#rv3-menu [data-online-act=${a}]`).click(), act);
      await sleep(150);
    }
  };

  // 1) a sala já foi fechada no servidor (ou a rede falha): "Fechar sala" antes ficava preso
  const a = await open('/close', '409');
  await menuAct(a, 'close', 2);
  await a.waitFor(() => !window.DuoTelaOnline.active);
  check('Fechar a sala com erro do servidor (409) volta ao início em vez de travar', !(await active(a)) && await inLobby(a), JSON.stringify(await a.evaluate(() => ({ campo: !!document.querySelector('#online-display-name'), rv3: document.querySelector('#rv3')?.hidden, offsetParent: !!document.querySelector('#rv3')?.offsetParent }))));

  // 2) rede caída na hora de fechar
  const b = await open('/close', 'network');
  await menuAct(b, 'close', 2);
  await b.waitFor(() => !window.DuoTelaOnline.active);
  check('Fechar a sala sem rede também sai', !(await active(b)) && await inLobby(b));

  // 3) outra ação pendurada (botão ocupado): sair ainda funciona na hora
  const c = await open('/actions', 'hang');
  await c.evaluate(() => document.querySelector('[data-online-act=ready-toggle]').click());   // fica pendurada: "ocupado"
  await sleep(300);
  check('com uma ação pendurada, a tela está ocupada (como no travamento real)', await c.evaluate(() => document.querySelector('.online-room').getAttribute('aria-busy') === 'true'));
  const t0 = Date.now();
  await menuAct(c, 'close', 2);
  await c.waitFor(() => !window.DuoTelaOnline.active);
  check('Fechar a sala funciona mesmo com outra ação pendurada, em poucos segundos', !(await active(c)) && await inLobby(c) && Date.now() - t0 < 9000, (Date.now() - t0) + ' ms');
  check('depois de sair, a tela não fica marcada como ocupada', await c.evaluate(() => !document.querySelector('.online-room').hasAttribute('aria-busy')));

  // 4) caminho normal continua funcionando e dá para criar outra sala depois
  const d = await open();
  await menuAct(d, 'close', 2);
  await d.waitFor(() => !window.DuoTelaOnline.active);
  await d.evaluate(() => { const n = document.querySelector('#online-display-name'); n.value = 'Ana'; n.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-online-act=create]').click(); });
  await d.waitFor(() => window.DuoTelaOnline.snapshot?.status === 'active');
  check('Fechar normalmente e criar outra sala em seguida funciona', await active(d));

  // nada marcado como escondido pode continuar visível (era o caso do painel da sala depois de fechar)
  const leaks = (p) => p.evaluate(() => [...document.querySelectorAll('[hidden]')].filter((el) => !(el instanceof HTMLDialogElement) && el.getClientRects().length > 0).map((el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0])).slice(0, 6));
  const lk = await leaks(a);
  check('depois de fechar a sala nenhum elemento escondido continua visível', lk.length === 0, lk.join(', '));
  const errs = [a, b, c, d].flatMap((p) => p.logs.filter((l) => /EXCEPTION|error:/.test(l) && !/Failed to fetch|Failed to load resource|net::|409/i.test(l)));
  check('sem exceções no console', errs.length === 0, errs.slice(0, 3).join(' || '));
} finally {
  await chrome.close();
  await svc.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações em navegador`);
process.exit(failed.length ? 1 : 0);
