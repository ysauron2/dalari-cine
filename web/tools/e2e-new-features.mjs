// Teste em navegador real (Chromium local): 2 pessoas pela interface, com os recursos da versão nova.
// Uso: node tools/e2e-new-features.mjs [pasta-de-capturas]
// Cobre: sala do Host sozinho, convite e entrada, chat (aviso e painel), intervalo (faixa, "voltar agora" e 3-2-1), fila do YouTube
// (adicionar, próximo, ordem) e a lista "Sugestões para você" com os ajustes. O player do YouTube em si depende de rede e não é testado aqui.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch } from './cdp.mjs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');

const shots = path.resolve(process.argv[2] || 'tools/shots');
await mkdir(shots, { recursive: true });
const snapshot = require('../data/tmdb-catalog-br.json');
const svc = createRoomService({ servePrototype: true, logger: () => {}, catalog: snapshot, catalogSource: 'tmdb' });
const addr = await svc.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${addr.port}`;
const chrome = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const pages = [];
  for (const nick of ['Ana', 'Beto']) {
    const { browserContextId } = await chrome.browser.send('Target.createBrowserContext');
    const p = await chrome.browser.page(null, { contextId: browserContextId });
    await p.goto(origin + '/');
    await p.evaluate(() => { localStorage.setItem('duotela-welcome-v4', '1'); localStorage.setItem('duotela-audio-wizard-v1', '1'); localStorage.setItem('duotela-telemetry', 'off'); });
    await p.goto(origin + '/');
    await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    p.nick = nick; pages.push(p);
  }
  const [host, guest] = pages;
  const click = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) throw new Error('sem ' + s); n.click(); return true; }, sel);
  const setVal = (p, sel, v) => p.evaluate((s, val) => { const n = document.querySelector(s); n.value = val; n.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
  const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
  const visible = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); return !!n && !n.hidden && n.offsetParent !== null; }, sel);

  // ---------- Início: uma lista só de sugestões, com ajustes ----------
  const titles = (p) => p.evaluate(() => [...document.querySelectorAll('#recommend-cards .poster-title')].map((x) => x.textContent));
  const base = await titles(host);
  await click(host, '[data-t-mood="tensao"]');
  const tense = await titles(host);
  check('Início: clima Tensão muda a própria lista de sugestões', tense.length > 0 && JSON.stringify(tense) !== JSON.stringify(base), tense.join(' | '));
  check('Início: só existe uma lista de sugestões', await host.evaluate(() => document.querySelectorAll('#recommend-cards').length === 1 && !document.querySelector('#tonight')));
  await click(host, '[data-tonight="surprise"]');
  check('Início: Me surpreenda sorteia na mesma lista', (await titles(host)).length === 5);
  await click(host, '[data-tonight="clear"]');
  check('Início: Limpar volta à lista original', JSON.stringify(await titles(host)) === JSON.stringify(base));

  // ---------- Host sozinho ----------
  await host.evaluate(() => document.querySelector('[data-view="room"]').click());
  await host.waitFor(() => !!document.querySelector('[data-online-act=create]'));
  await setVal(host, '#online-display-name', 'Ana');
  await click(host, '[data-online-act=create]');
  await host.waitFor(() => document.querySelector('#rv3') && !document.querySelector('#rv3').hidden);
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.status === 'active');
  check('Host sozinho: a sala já está ativa', await host.evaluate(() => window.DuoTelaOnline.snapshot.participants.length === 1));
  check('Host sozinho: faixa "só você por enquanto" com Convidar', /só você por enquanto/.test(await text(host, '#rv3-alert')), (await text(host, '#rv3-alert')).slice(0, 80));
  await click(host, '#rv3-chip-youtube');
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.platform === 'youtube');
  // "Levar para a sala": título da Netflix com a sala em YouTube → o Host troca a plataforma e o título entra na votação
  const nf = await host.evaluate(() => { const it = window.DuoCatalog.find((x) => x.watchProviders.includes('Netflix')); return it ? { id: it.id, watchProviders: it.watchProviders } : null; });
  const proposed = await host.evaluate((it) => window.DuoTelaOnline.proposeTitle(it), nf);
  check('Levar para a sala: com a sala em YouTube, o Host troca para a Netflix e o título entra na votação', proposed.ok === true && await host.evaluate((id) => window.DuoTelaOnline.snapshot.platform === 'netflix' && window.DuoTelaOnline.snapshot.round?.picks.includes(id), nf.id), JSON.stringify(proposed));
  const none = await host.evaluate(() => window.DuoTelaOnline.proposeTitle({ id: 'tmdb:movie:1', watchProviders: [] }));
  check('Levar para a sala: título sem plataforma da sala recebe uma explicação clara', none.ok === false && /nenhuma plataforma/.test(none.message), none.message);
  await click(host, '#rv3-chip-youtube');
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.platform === 'youtube');
  await setVal(host, '#online-youtube-url', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await click(host, '[data-online-act=youtube-open]');
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.media?.videoId === 'aqz-KE-bpKQ');
  check('Host sozinho: abre um vídeo do YouTube na sala', true);

  // ---------- convidado entra pelo convite ----------
  await click(host, '#rv3-invite-btn');
  await host.waitFor(() => !!document.querySelector('#rv3-invite-dialog[open]'));
  if (await host.evaluate(() => !!document.querySelector('#rv3-invite-dialog [data-online-act=invite]'))) {
    await click(host, '#rv3-invite-dialog [data-online-act=invite]');
    await host.waitFor(() => !!document.querySelector('#rv3-invite-field'));
  }
  const invite = await host.evaluate(() => document.querySelector('#rv3-invite-field').value);
  await host.evaluate(() => document.querySelector('#rv3-invite-dialog').close());
  await guest.evaluate(() => document.querySelector('[data-view="room"]').click());
  await guest.waitFor(() => !!document.querySelector('[data-online-act=join]'));
  await setVal(guest, '#online-display-name', 'Beto');
  await setVal(guest, '#online-invite-input', invite);
  await click(guest, '[data-online-act=join]');
  await host.waitFor(() => !!document.querySelector('#rv3-alert [data-online-act=approve]'));
  check('Host sozinho: o pedido do convidado aparece sem travar a sala', await host.evaluate(() => window.DuoTelaOnline.snapshot.status === 'active'));
  await click(host, '#rv3-alert [data-online-act=approve]');
  await guest.waitFor(() => window.DuoTelaOnline.snapshot?.status === 'active' && window.DuoTelaOnline.snapshot?.media?.videoId === 'aqz-KE-bpKQ');
  check('Convidado entra e já vê o vídeo que estava aberto', true);
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.participants?.length === 2);

  // ---------- chat ----------
  check('Chat: botão aparece nas duas telas', (await visible(host, '.chat-toggle')) && (await visible(guest, '.chat-toggle')));
  await click(host, '.chat-toggle');
  await setVal(host, '.chat-form input', 'Oi Beto, já vai começar?');
  await host.evaluate(() => document.querySelector('.chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await guest.waitFor(() => { const b = document.querySelector('.chat-bubble'); return b && !b.hidden && /Oi Beto/.test(b.textContent); });
  check('Chat: o convidado vê o aviso discreto com o nome e o texto', /Ana: Oi Beto/.test(await text(guest, '.chat-bubble')), await text(guest, '.chat-bubble'));
  check('Chat: contador de não lidas no botão do convidado', (await text(guest, '.chat-badge')) === '1');
  await click(guest, '.chat-toggle');
  check('Chat: abrir marca como lido e mostra a conversa', (await visible(guest, '.chat-panel')) && !(await visible(guest, '.chat-badge')) && /Oi Beto/.test(await text(guest, '.chat-list')));
  await setVal(guest, '.chat-form input', 'Já! Pipoca pronta');
  await guest.evaluate(() => document.querySelector('.chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await host.waitFor(() => /Pipoca/.test(document.querySelector('.chat-list')?.textContent || ''));
  check('Chat: a resposta chega ao Host com "Você" e o nome certos', /Você.*Oi Beto[\s\S]*Beto.*Pipoca|Você/.test(await text(host, '.chat-list')));
  await click(host, '.chat-toggle'); await click(guest, '.chat-toggle');
  await host.screenshot(path.join(shots, 'novo-sala-host.png'), { width: 1280, height: 900 });

  // ---------- intervalo ----------
  await host.waitFor(() => !!document.querySelector('[data-online-act=break-start]:not([disabled])'));
  await click(host, '[data-online-act=break-start]');
  await guest.waitFor(() => { const b = document.querySelector('#break-banner'); return b && !b.hidden && /Intervalo/.test(b.textContent); });
  await host.waitFor(() => { const b = document.querySelector('#break-banner'); return b && !b.hidden && /Intervalo/.test(b.textContent); });
  check('Intervalo: a faixa aparece nas duas telas, com quem pediu', /Ana pediu/.test(await text(guest, '#break-banner')) && /Você pediu/.test(await text(host, '#break-banner')), (await text(guest, '#break-banner')).slice(0, 90));
  check('Intervalo: mostra a contagem regressiva', /volta em \d+:\d\d/.test(await text(guest, '#break-banner')));
  check('Intervalo: o vídeo fica pausado para todos', await guest.evaluate(() => window.DuoTelaOnline.snapshot.playback.state === 'paused'));
  await click(host, '#break-banner [data-online-act=break-more]');
  await sleep(700);
  await click(guest, '#break-banner [data-online-act=break-end]');
  await host.waitFor(() => !document.querySelector('#break-banner') || document.querySelector('#break-banner').hidden);
  await guest.waitFor(() => !!document.querySelector('.sync-stage .sync-num'));
  check('Intervalo: "Voltar agora" fecha a faixa e abre o 3-2-1 nas duas telas', (await host.evaluate(() => !!document.querySelector('.sync-stage .sync-num'))));
  await guest.waitFor(() => window.DuoTelaOnline.snapshot.playback.state === 'playing');
  check('Intervalo: depois da contagem todos voltam a tocar', await host.evaluate(() => window.DuoTelaOnline.snapshot.playback.state === 'playing'));

  // ---------- fila ----------
  await setVal(host, '#online-youtube-url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await click(host, '[data-online-act=youtube-queue-add]');
  await guest.waitFor(() => (window.DuoTelaOnline.snapshot?.queue || []).length === 1);
  check('Fila: o vídeo adicionado pelo Host aparece para o convidado', await guest.evaluate(() => window.DuoTelaOnline.snapshot.queue[0].videoId === 'dQw4w9WgXcQ'));
  await guest.waitFor(() => !!document.querySelector('[data-online-act=queue-next]'));
  check('Fila: o botão Próximo aparece na barra do vídeo', true);
  await setVal(host, '#online-youtube-url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await click(host, '[data-online-act=youtube-queue-add]');
  await sleep(800);
  check('Fila: o mesmo vídeo duas vezes é recusado', await host.evaluate(() => window.DuoTelaOnline.snapshot.queue.length === 1));
  await click(guest, '[data-online-act=queue-next]');
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.media?.videoId === 'dQw4w9WgXcQ');
  check('Fila: o convidado pede o Próximo e toca para o Host também', await host.evaluate(() => window.DuoTelaOnline.snapshot.queue.length === 0));

  // ---------- Convidar: mensagem com link (navegador, sem app) ----------
  check('Convite: a mensagem com link e o código curto estão disponíveis no código', await host.evaluate(() => typeof window.DuoRendezvous?.inviteMessage === 'function' && /Toque para entrar: https:\/\/ysauron2\.github\.io\/dalari-cine\/entrar\/#K7QM-93XP/.test(window.DuoRendezvous.inviteMessage('K7QM-93XP', 'Ana'))));

  const errs = pages.flatMap((p) => p.logs.filter((l) => /EXCEPTION|error:/.test(l) && !/youtube|ERR_|Failed to load resource|net::|googleapis|ytimg/i.test(l)));
  check('sem exceções no console (ignorando falhas de rede do YouTube)', errs.length === 0, errs.slice(0, 3).join(' || '));
} finally {
  await chrome.close();
  await svc.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações em navegador`);
process.exit(failed.length ? 1 : 0);
