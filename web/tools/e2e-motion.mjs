// Teste em navegador real (Chromium local): níveis de movimento, tokens e fonte embutida, com o "reduzir movimento" do SISTEMA ligado
// (o caso do dono do projeto). Uso: node tools/e2e-motion.mjs
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
  const { browserContextId } = await chrome.browser.send('Target.createBrowserContext');
  const p = await chrome.browser.page(null, { contextId: browserContextId });
  await p.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await p.goto(origin + '/');
  await p.evaluate(() => { localStorage.setItem('duotela-welcome-v4', '1'); localStorage.setItem('duotela-audio-wizard-v1', '1'); localStorage.setItem('duotela-telemetry', 'off'); localStorage.removeItem('duotela-motion'); });
  await p.goto(origin + '/');
  await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));

  const level = () => p.evaluate(() => document.documentElement.getAttribute('data-motion'));
  check('sistema pede menos movimento + automático = Reduzido', (await level()) === 'reduced', await level());
  check('tokens carregados (espaçamento, raio, movimento)', await p.evaluate(() => { const s = getComputedStyle(document.documentElement); return s.getPropertyValue('--space-4').trim() === '16px' && s.getPropertyValue('--radius-pill').trim() === '999px' && s.getPropertyValue('--motion-scale').trim() === '.01'; }));
  check('fonte Inter embutida foi baixada e está em uso', await p.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Inter' && f.status === 'loaded'); }));

  // sala solo para testar a reação em cada nível
  await p.evaluate(() => document.querySelector('[data-view="room"]').click());
  await p.waitFor(() => !!document.querySelector('[data-online-act=create]'));
  await p.evaluate(() => { const n = document.querySelector('#online-display-name'); n.value = 'Ana'; n.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-online-act=create]').click(); });
  await p.waitFor(() => window.DuoTelaOnline.snapshot?.status === 'active');
  const reaction = async () => {
    await sleep(750);                                      // a sala limita uma reação a cada 0,6 s
    await p.evaluate(() => { document.querySelectorAll('.reaction-fly').forEach((n) => n.remove()); window.__lastReact = 0; document.querySelector('.react-btn').click(); });
    await sleep(500);
    return p.evaluate(() => { const f = document.querySelector('.reaction-fly'); if (!f) return null; const cs = getComputedStyle(f); const r = f.getBoundingClientRect(); return { opacity: Number(cs.opacity), dur: cs.animationDuration, top: Math.round(r.top) }; });
  };
  const r1 = await reaction();
  check('Reduzido: a reação fica visível (não some na hora)', r1 && r1.opacity === 1 && r1.dur === '2s', JSON.stringify(r1));

  // trocar para Completo pela tela de Perfil: vence o sistema
  await p.evaluate(() => document.querySelector('[data-view="profile"]').click());
  await p.evaluate(() => { const s = document.querySelector('#motion-select'); s.value = 'full'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  check('Completo escolhido no Perfil vence o sistema', (await level()) === 'full' && await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-scale').trim() === '1'));
  check('explicação aparece no Perfil', /Completo, por escolha sua/.test(await p.evaluate(() => document.querySelector('#motion-note').textContent)));
  await p.evaluate(() => document.querySelector('[data-view="room"]').click());
  const r2 = await reaction();
  check('Completo: a reação anima de verdade (sobe e desvanece)', r2 && r2.dur === '2.8s' && r2.opacity > 0 && r2.opacity <= 1, JSON.stringify(r2));
  check('Completo: animação de entrada dos cartões volta a existir', await p.evaluate(() => { document.querySelector('[data-view="home"]').click(); const c = document.querySelector('.card, .dcard, .section'); return !!c && getComputedStyle(c).animationDuration !== '0.00001s' && parseFloat(getComputedStyle(c).animationDuration) > 0.01; }));

  // Desligado
  await p.evaluate(() => document.querySelector('[data-view="profile"]').click());
  await p.evaluate(() => { const s = document.querySelector('#motion-select'); s.value = 'off'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  check('Desligado: nível aplicado', (await level()) === 'off');
  await p.evaluate(() => document.querySelector('[data-view="room"]').click());
  const r3 = await reaction();
  check('Desligado: a reação continua visível por 2 s, sem se mover', r3 && r3.opacity === 1 && r3.dur === '2s', JSON.stringify(r3));

  // a escolha persiste ao recarregar
  await p.goto(origin + '/');
  check('a escolha é lembrada ao reabrir o app', (await level()) === 'off');
  await p.evaluate(() => { const s = document.querySelector('#motion-select'); return s.value; }).then((v) => check('o seletor mostra a escolha guardada', v === 'off', v));

  const errs = p.logs.filter((l) => /EXCEPTION|error:/.test(l) && !/youtube|ERR_|Failed to load resource|net::|googleapis|ytimg/i.test(l));
  check('sem exceções no console', errs.length === 0, errs.slice(0, 3).join(' || '));
} finally {
  await chrome.close();
  await svc.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações em navegador`);
process.exit(failed.length ? 1 : 0);
