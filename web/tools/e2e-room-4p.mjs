// Teste em navegador real (Chromium local, mídia falsa do próprio Chromium): 4 pessoas pela interface.
// Uso: node tools/e2e-room-4p.mjs [pasta-de-capturas]
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');

const shots = path.resolve(process.argv[2] || 'tools/shots');
await mkdir(shots, { recursive: true });
const svc = createRoomService({ servePrototype: true, logger: () => {} });
const addr = await svc.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${addr.port}`;
const chrome = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${detail ? ' — ' + detail : ''}`); };
try {
  const names = ['Ana', 'Beto', 'Cida', 'Davi'];
  const pages = [];
  for (const name of names) {
    const { browserContextId } = await chrome.browser.send('Target.createBrowserContext');
    const p = await chrome.browser.page(null, { contextId: browserContextId });
    // observa as conexões WebRTC reais para provar a malha
    await p.call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; })();` });
    await p.goto(origin + '/');
    await p.evaluate(() => document.querySelector('[data-view="room"]').click());
    await p.waitFor(() => !!document.querySelector('[data-online-act=create]'));
    p.nick = name;
    pages.push(p);
  }
  const [host, ...guests] = pages;
  const click = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) throw new Error('sem ' + s); n.click(); return true; }, sel);
  const setVal = (p, sel, v) => p.evaluate((s, val) => { const n = document.querySelector(s); n.value = val; n.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
  const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || '', sel);

  await setVal(host, '#online-display-name', 'Ana');
  await click(host, '[data-online-act=create]');
  await host.waitFor(() => document.querySelector('#rv3') && !document.querySelector('#rv3').hidden);
  const invite = async () => {
    await click(host, '#rv3-invite-btn');
    await host.waitFor(() => !!document.querySelector('#rv3-invite-dialog[open]'));
    if (await host.evaluate(() => !!document.querySelector('#rv3-invite-dialog [data-online-act=invite]'))) {
      await click(host, '#rv3-invite-dialog [data-online-act=invite]');
      await host.waitFor(() => !!document.querySelector('#rv3-invite-field'));
    }
    const v = await host.evaluate(() => document.querySelector('#rv3-invite-field').value);
    await host.evaluate(() => document.querySelector('#rv3-invite-dialog').close());
    return v;
  };
  for (let i = 0; i < 3; i++) {
    const inv = await invite();
    const g = guests[i];
    await setVal(g, '#online-display-name', names[i + 1]);
    await setVal(g, '#online-invite-input', inv);
    await click(g, '[data-online-act=join]');
    await host.waitFor((n) => [...document.querySelectorAll('#rv3-alert [data-online-act=approve]')].some((b) => b.textContent.includes(n)), names[i + 1]);
    await host.evaluate((n) => [...document.querySelectorAll('#rv3-alert [data-online-act=approve]')].find((b) => b.textContent.includes(n)).click(), names[i + 1]);
    await g.waitFor(() => document.querySelector('#rv3-grid') && !document.querySelector('#rv3-grid').hidden);
  }
  await host.waitFor(() => document.querySelectorAll('#people-top .avatar').length === 4);
  check('4 pessoas aparecem no cartão da sala do Host', true, await text(host, '#people-top .people-names'));
  for (const g of guests) await g.waitFor(() => document.querySelectorAll('#people-top .avatar').length === 4);
  check('os 3 convidados também veem 4 avatares', true);
  await host.screenshot(path.join(shots, '4p-sala-host-desktop.png'), { width: 1280, height: 900 });

  // quinto participante: sala cheia, o botão Convidar explica e não oferece convite
  await click(host, '#rv3-invite-btn');
  const fullMsg = await host.evaluate(() => document.querySelector('#rv3-invite-dialog').textContent);
  check('Convidar com sala cheia não oferece convite', /cheia/.test(fullMsg) && !(await host.evaluate(() => !!document.querySelector('#rv3-invite-dialog [data-online-act=invite]'))), fullMsg.slice(0, 90));
  await host.evaluate(() => document.querySelector('#rv3-invite-dialog').close());

  // plataforma Netflix + rodada
  await click(host, '#rv3-chip-netflix');
  await host.waitFor(() => document.querySelector('#rv3-chip-netflix')?.getAttribute('aria-pressed') === 'true');
  await host.waitFor(() => !!document.querySelector('#stage-empty [data-online-act=surprise]'));
  await click(host, '#stage-empty [data-online-act=surprise]');
  for (const p of pages) { await p.evaluate(() => { const t = document.querySelector('[data-online-act=tab-match]'); t?.click(); }); await p.waitFor(() => document.querySelectorAll('.pick').length === 3); }
  const firstTitle = await host.evaluate(() => document.querySelector('.pick [data-online-act=yes]').dataset.id);
  const vote = (p) => p.evaluate((id) => document.querySelector(`.pick [data-online-act=yes][data-id="${id}"]`).click(), firstTitle);
  for (let i = 0; i < 3; i++) { await vote(pages[i]); await new Promise((r) => setTimeout(r, 250)); }
  await host.waitFor(() => document.querySelectorAll('.pick-votes')[0].querySelectorAll('.vchip.yes').length === 3);
  const chips = await host.evaluate(() => [...document.querySelectorAll('.pick-votes')[0].querySelectorAll('.vchip')].map((c) => c.textContent));
  check('votos individuais por nome (3/4)', chips.length === 4 && chips.filter((c) => c.includes('Quer ver')).length === 3 && chips.some((c) => c.includes('Davi') && c.includes('Aguardando')), chips.join(' | '));
  check('3/4 não é match', !(await host.evaluate(() => !!document.querySelector('.match-banner'))));
  await host.screenshot(path.join(shots, '4p-votos-3de4-desktop.png'), { width: 1280, height: 900 });
  await vote(pages[3]);
  await host.waitFor(() => !!document.querySelector('.match-banner'));
  check('4/4 vira match para todos', true);
  for (const p of pages) await p.waitFor(() => !!document.querySelector('.match-banner'));
  await host.screenshot(path.join(shots, '4p-match-desktop.png'), { width: 1280, height: 900 });

  // preferências individuais: todos aparecem, mas cada pessoa edita apenas a própria avaliação
  await click(pages[2], '.pick.is-match [data-online-act=details]');
  await pages[2].waitFor(() => document.querySelectorAll('#group-ratings label').length === 4);
  const ratingAccess = await pages[2].evaluate(() => [...document.querySelectorAll('#group-ratings select')].map((s) => ({ label: s.getAttribute('aria-label'), disabled: s.disabled })));
  check('detalhes mostram quatro avaliações e só Cida pode editar a própria', ratingAccess.length === 4 && ratingAccess.filter((x) => !x.disabled).length === 1 && ratingAccess.some((x) => x.label === 'Avaliação de Cida' && !x.disabled), JSON.stringify(ratingAccess));
  await pages[2].evaluate(() => { const s = [...document.querySelectorAll('#group-ratings select')].find((x) => !x.disabled); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await pages[2].waitFor((id) => window.DuoTelaOnline.snapshot?.viewing?.guest2?.[id]?.rating === 1, firstTitle);
  await click(pages[2], '#close-modal');
  await click(host, '.pick.is-match [data-online-act=details]');
  await host.waitFor(() => [...document.querySelectorAll('#group-ratings select')].some((x) => x.getAttribute('aria-label') === 'Avaliação de Cida' && x.value === '1' && x.disabled));
  check('avaliação de Cida sincroniza e fica somente leitura para Ana', true);
  await click(host, '#close-modal');

  // voz: 4 pessoas ligam o microfone (mídia falsa) e a malha conecta de verdade
  for (const p of pages) { await click(p, '[data-online-act=voice-join]'); await new Promise((r) => setTimeout(r, 300)); }
  let states = [];
  try {
    for (const p of pages) await p.waitFor(() => window.__pcs.length === 3 && window.__pcs.every((pc) => pc.connectionState === 'connected'));
    states = await Promise.all(pages.map((p) => p.evaluate(() => window.__pcs.map((pc) => pc.connectionState))));
    check('voz em malha: cada navegador tem 3 conexões WebRTC conectadas', states.every((s) => s.length === 3 && s.every((x) => x === 'connected')), JSON.stringify(states));
  } catch (e) {
    states = await Promise.all(pages.map((p) => p.evaluate(() => window.__pcs.map((pc) => pc.connectionState + '/' + pc.iceConnectionState))));
    check('voz em malha: cada navegador tem 3 conexões WebRTC conectadas', false, JSON.stringify(states));
  }
  const audios = await Promise.all(pages.map((p) => p.evaluate(() => [...document.querySelectorAll('audio')].filter((a) => a.srcObject).length)));
  check('um elemento de áudio com stream remoto por ligação', audios.every((n) => n === 3), JSON.stringify(audios));
  check('rótulo de voz para várias pessoas', /Conversando/.test(await text(host, '.voice-note')), await text(host, '.voice-note'));
  await host.screenshot(path.join(shots, '4p-voz-desktop.png'), { width: 1280, height: 900 });

  // saída de uma pessoa: as outras três ligações continuam
  await click(pages[3], '[data-online-act=menu]'); await click(pages[3], '[data-online-act=leave]');
  await host.waitFor(() => document.querySelectorAll('#people-top .avatar').length === 3);
  await click(host, '[data-online-act=tab-match]');
  await host.waitFor(() => /Saiu depois do match/.test(document.querySelector('#rv3-tabpanel').textContent));
  check('saída de Davi: sala mostra 3 pessoas e o aviso de saída pós-match', true, await host.evaluate(() => document.querySelector('.note-green')?.textContent));
  await host.waitFor(() => window.__pcs.filter((pc) => pc.connectionState === 'connected').length >= 2);
  check('voz entre os 3 restantes continua', true);

  // mobile
  await guests[0].screenshot(path.join(shots, '4p-sala-convidado-mobile.png'), { width: 390, height: 900 });
  const overflow = await guests[0].evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('sem rolagem horizontal em 390px', overflow <= 1, 'excesso ' + overflow + 'px');
  const errs = pages.flatMap((p) => p.logs.filter((l) => /EXCEPTION|error:/.test(l)));
  check('sem exceções no console', errs.length === 0, errs.slice(0, 3).join(' || '));
} finally {
  await chrome.close();
  await svc.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações em navegador`);
process.exit(failed.length ? 1 : 0);
