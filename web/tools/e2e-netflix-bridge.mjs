// Teste em navegador real da ponte Netflix: Chromium local + a extensão extension-bridge carregada sem publicação.
// A "Netflix" é uma página FALSA servida por interceptação (Fetch.fulfillRequest) no endereço https://www.netflix.com/watch/<id>:
// o Chromium é lançado com todas as resoluções de DNS externas bloqueadas, então nenhum pacote chega à Netflix real.
// Nada é provado sobre a Netflix real (login, DRM, player real): só a extensão, o hub, a sala e a interface.
// Uso: node tools/e2e-netflix-bridge.mjs [pasta-de-capturas]   (DUOTELA_PEOPLE=2..4, padrão 3)
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch } from './cdp.mjs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');

const N = Math.min(4, Math.max(2, Number(process.env.DUOTELA_PEOPLE || 3)));
const shots = path.resolve(process.argv[2] || 'tools/shots');
await mkdir(shots, { recursive: true });
const EXT = path.resolve('extension-bridge');
const WATCH = '80057281';
const svc = createRoomService({ servePrototype: true, logger: () => {} });
const addr = await svc.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${addr.port}`;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ' — ' + detail : ''}`); };

// 30 s de silêncio em WAV 8 kHz/8 bits: finito, com faixa de áudio e pesquisável, para o <video> da página falsa.
function wavDataUrl(seconds = 30) {
  const n = 8000 * seconds, buf = Buffer.alloc(44 + n, 128);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(8000, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  return 'data:audio/wav;base64,' + buf.toString('base64');
}
const FAKE_PAGE = `<!doctype html><html><head><title>Página FALSA de teste (não é a Netflix)</title></head><body style="margin:0;background:#000">
<div class="watch-video--player-view" style="width:640px;height:360px"><video id="v" style="width:640px;height:360px"></video></div>
<script>document.getElementById('v').src='${wavDataUrl()}';</script></body></html>`;

const chromes = [];
try {
  const names = ['Ana', 'Beto', 'Cida', 'Davi'].slice(0, N);
  const people = [];
  for (let i = 0; i < N; i++) {
    // Beto (índice 1) roda SEM a flag de autoplay: o Chromium bloqueia play() sem gesto e a ponte deve oferecer "Reproduzir aqui".
    const chrome = await launch({ autoplay: i !== 1, args: [`--load-extension=${EXT}`, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', ...(i === 1 ? ['--autoplay-policy=user-gesture-required'] : [])] });
    chromes.push(chrome);
    const room = await chrome.browser.page(origin + '/');
    await room.evaluate(() => document.querySelector('[data-view="room"]').click());
    await room.waitFor(() => !!document.querySelector('[data-online-act=create]'));
    people.push({ name: names[i], chrome, room, netflix: null });
  }
  const click = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) throw new Error('sem ' + s); n.click(); return true; }, sel);
  const setVal = (p, sel, v) => p.evaluate((s, val) => { const n = document.querySelector(s); n.value = val; n.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
  const [host, ...guests] = people;

  // ---- sala + match, tudo pela interface ----
  await setVal(host.room, '#online-display-name', host.name);
  await click(host.room, '[data-online-act=create]');
  await host.room.waitFor(() => document.querySelector('#rv3') && !document.querySelector('#rv3').hidden);
  const makeInvite = async () => {
    await click(host.room, '#rv3-invite-btn');
    await host.room.waitFor(() => !!document.querySelector('#rv3-invite-dialog[open]'));
    if (await host.room.evaluate(() => !!document.querySelector('#rv3-invite-dialog [data-online-act=invite]'))) {
      await click(host.room, '#rv3-invite-dialog [data-online-act=invite]');
      await host.room.waitFor(() => !!document.querySelector('#rv3-invite-field'));
    }
    const v = await host.room.evaluate(() => document.querySelector('#rv3-invite-field').value);
    await host.room.evaluate(() => document.querySelector('#rv3-invite-dialog').close());
    return v;
  };
  for (const g of guests) {
    const inv = await makeInvite();
    await setVal(g.room, '#online-display-name', g.name);
    await setVal(g.room, '#online-invite-input', inv);
    await click(g.room, '[data-online-act=join]');
    try { await host.room.waitFor((n) => [...document.querySelectorAll('#rv3-alert [data-online-act=approve]')].some((b) => b.textContent.includes(n)), g.name); }
    catch (e) { console.log('DEBUG host:', await host.room.evaluate(() => document.querySelector('#rv3-alert').outerHTML.slice(0, 500)), '| convidado:', await g.room.evaluate(() => document.querySelector('#online-message').textContent + ' | ' + (document.querySelector('#rv3-sub')?.textContent || '')), '| logs', host.room.logs.slice(-4), g.room.logs.slice(-4)); throw e; }
    await host.room.evaluate((n) => [...document.querySelectorAll('#rv3-alert [data-online-act=approve]')].find((b) => b.textContent.includes(n)).click(), g.name);
    await g.room.waitFor(() => document.querySelector('#rv3-grid') && !document.querySelector('#rv3-grid').hidden);
  }
  await click(host.room, '#rv3-chip-netflix');
  await host.room.waitFor(() => !!document.querySelector('#stage-empty [data-online-act=surprise]'));
  await click(host.room, '#stage-empty [data-online-act=surprise]');
  for (const p of people) { await p.room.evaluate(() => document.querySelector('[data-online-act=tab-match]').click()); await p.room.waitFor(() => document.querySelectorAll('.pick').length === 3); }
  const title = await host.room.evaluate(() => document.querySelector('.pick [data-online-act=yes]').dataset.id);
  for (const p of people) { await p.room.evaluate((id) => document.querySelector(`.pick [data-online-act=yes][data-id="${id}"]`).click(), title); await new Promise((r) => setTimeout(r, 250)); }
  for (const p of people) await p.room.waitFor(() => !!document.querySelector('.match-banner'));
  check(`${N} pessoas: match unânime pela interface`, true);

  // ---- a extensão real foi injetada nas abas da sala ----
  for (const p of people) await p.room.evaluate(() => document.querySelector('[data-online-act=tab-search]')?.click() || document.querySelector('#rv3-tab-search').click());
  for (const p of people) await p.room.waitFor(() => /Extensão ligada/.test(document.querySelector('#rv3-tabpanel')?.textContent || ''));
  check('extensão detectada em todas as abas da sala (handshake real, content script em 127.0.0.1)', true);

  // ---- abre a "Netflix" falsa no navegador de cada pessoa ----
  const openNetflix = async (p) => {
    const t = await p.chrome.browser.page(null);
    await t.intercept((url) => (/^https:\/\/www\.netflix\.com\/watch\//.test(url) ? { headers: { 'content-type': 'text/html; charset=utf-8' }, body: FAKE_PAGE } : null));
    await t.goto(`https://www.netflix.com/watch/${WATCH}`);
    await t.waitFor(() => document.getElementById('v')?.readyState >= 3);
    p.netflix = t;
  };
  await openNetflix(host);
  await host.room.waitFor(() => /\/watch\/80057281/.test(document.querySelector('#rv3-tabpanel').textContent) && !!document.querySelector('[data-online-act=nf-associate]'));
  check('o Host vê a aba Netflix aberta (só o watchId da URL) e precisa confirmar a associação', true);
  await host.room.screenshot(path.join(shots, 'netflix-painel-host.png'), { width: 1280, height: 1000 });
  // sem marcar a confirmação a associação não acontece
  await click(host.room, '[data-online-act=nf-associate]');
  await new Promise((r) => setTimeout(r, 400));
  check('sem confirmar, nada é associado', await host.room.evaluate(() => !document.querySelector('.match-banner p:last-child')?.textContent.includes('Título associado') && !/Título associado à sala/.test(document.querySelector('#rv3-tabpanel').textContent)));
  await host.room.evaluate(() => { document.querySelector('input[id^=nf-confirm-]').click(); });
  await click(host.room, '[data-online-act=nf-associate]');
  await host.room.waitFor(() => /Título associado à sala: \/watch\/80057281/.test(document.querySelector('#rv3-tabpanel').textContent));
  await host.room.waitFor(() => /Aba sincronizada/.test(document.querySelector('#rv3-tabpanel').textContent));
  check('Host associou o watchId e a sala selecionou media.netflix', true);
  await host.netflix.waitFor(() => !document.getElementById('v').paused);
  check('o vídeo da aba do Host toca (a sala começa tocando em 0:00)', true);

  // ---- os demais recebem o título e sincronizam com um clique ----
  for (const g of guests) {
    await g.room.waitFor(() => /Título associado à sala: \/watch\/80057281/.test(document.querySelector('#rv3-tabpanel').textContent));
    const link = await g.room.evaluate(() => document.querySelector('#rv3-tabpanel a[href*="netflix.com/watch"]')?.href);
    if (link !== `https://www.netflix.com/watch/${WATCH}`) throw new Error('link inesperado: ' + link);
    await openNetflix(g);
    await g.room.waitFor(() => !!document.querySelector('[data-online-act=nf-sync]'));
    await click(g.room, '[data-online-act=nf-sync]');
    await g.room.waitFor(() => /Aba sincronizada/.test(document.querySelector('#rv3-tabpanel').textContent));
  }
  check('os convidados recebem o link /watch/80057281 e sincronizam a própria aba', true);

  // Beto: Chromium sem gesto bloqueia o play → "Reproduzir aqui"; ninguém é pausado por isso
  const beto = guests[0];
  try { await beto.room.waitFor(() => /pediu um clique/.test(document.querySelector('#rv3-tabpanel').textContent) || /pediu um clique/.test(document.querySelector('#stage-bar').textContent)); } catch (e) { console.log('DEBUG beto:', JSON.stringify(await beto.netflix.evaluate(() => ({ paused: document.getElementById('v').paused, t: document.getElementById('v').currentTime, ready: document.getElementById('v').readyState }))), (await beto.room.evaluate(() => document.querySelector('#rv3-tabpanel').textContent)).slice(0, 400), '| bar:', await beto.room.evaluate(() => document.querySelector('#stage-bar').textContent)); throw e; }
  check('autoplay bloqueado no Chromium sem gesto: a interface avisa (status do hub) e oferece Reproduzir aqui na aba', true);
  check('o bloqueio local não pausa o Host', await host.netflix.evaluate(() => !document.getElementById('v').paused));
  await beto.room.screenshot(path.join(shots, 'netflix-autoplay-bloqueado-convidado.png'), { width: 1280, height: 1000 });
  await beto.netflix.screenshot(path.join(shots, 'netflix-aba-falsa-convidado-overlay.png'), { width: 900, height: 500 });
  // clique REAL do usuário (evento de entrada confiável do CDP) sobre o botão "Reproduzir aqui" (canto inferior esquerdo da aba 900x500)
  await beto.netflix.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 363, y: 457, button: 'left', clickCount: 1 });
  await beto.netflix.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 363, y: 457, button: 'left', clickCount: 1 });
  try { await beto.netflix.waitFor(() => !document.getElementById('v').paused); check('clique em "Reproduzir aqui" inicia o vídeo só nesta aba', true); }
  catch (e) { check('clique em "Reproduzir aqui" inicia o vídeo só nesta aba', false, 'coordenadas do botão não acertaram ou play continuou bloqueado'); }

  // ---- pause / seek / play entre navegadores reais ----
  const paused = (p) => p.netflix.evaluate(() => document.getElementById('v').paused);
  const pos = (p) => p.netflix.evaluate(() => document.getElementById('v').currentTime);
  await host.netflix.evaluate(() => { document.getElementById('v').currentTime = 12; document.getElementById('v').pause(); });
  for (const g of guests) await g.netflix.waitFor(() => document.getElementById('v').paused && Math.abs(document.getElementById('v').currentTime - 12) < 3);
  check('pause do Host chega a todos na posição ~12 s', true);
  const last = guests[guests.length - 1];
  await last.netflix.evaluate(() => { document.getElementById('v').currentTime = 25; });
  for (const p of people) await p.netflix.waitFor(() => Math.abs(document.getElementById('v').currentTime - 25) < 3);
  check(`seek de ${last.name} (25 s) chega a todos`, true);
  await new Promise((r) => setTimeout(r, 1500));
  check('sem eco: as abas continuam pausadas e paradas em ~25 s após 1,5 s', (await Promise.all(people.map(async (p) => (await paused(p)) && Math.abs((await pos(p)) - 25) < 3))).every(Boolean));
  const state = await host.room.evaluate(() => window.DuoTelaOnline.snapshot.playback);
  check('a sala registrou as ações com autor e versão', state.state === 'paused' && state.version >= 3 && state.updatedBy !== undefined, JSON.stringify({ v: state.version, by: state.updatedBy, st: state.state }));

  // ---- próximo episódio: a aba do último convidado vai para outro /watch ----
  // navegação SPA da Netflix (autoplay do próximo episódio): a URL muda sem recarregar a página
  await last.netflix.evaluate((id) => history.pushState({}, '', '/watch/' + id), String(Number(WATCH) + 1));
  await last.room.waitFor(() => /outro título/.test(document.querySelector('#rv3-tabpanel').textContent));
  check('aba que abre outro /watch/ é desassociada com aviso; a sala mantém o título', await host.room.evaluate(() => window.DuoTelaOnline.snapshot.media.watchId === '80057281'));
  await host.netflix.evaluate(() => document.getElementById('v').play());
  await host.netflix.waitFor(() => !document.getElementById('v').paused);
  for (const p of people.filter((x) => x !== last)) await p.netflix.waitFor(() => !document.getElementById('v').paused);
  check('as demais abas continuam sincronizadas após a saída de uma', true);

  // ---- credencial não aparece em nenhum contexto da página Netflix ----
  const probes = await Promise.all(people.map((p) => p.netflix.evaluate(() => ({ runtime: typeof (window.chrome && window.chrome.runtime && window.chrome.runtime.id), core: typeof window.DuoTelaNetflixRoomSyncCore, content: typeof window.DuoTelaNetflixContent, protocol: typeof window.DuoTelaBridgeProtocol, html: document.documentElement.outerHTML.includes('Bearer') }))));
  check('a página Netflix (mundo principal) não enxerga a API nem as variáveis da extensão', probes.every((x) => x.runtime === 'undefined' && x.core === 'undefined' && x.content === 'undefined' && x.protocol === 'undefined' && !x.html), JSON.stringify(probes[0]));
  const errs = people.flatMap((p) => p.room.logs.filter((l) => /EXCEPTION/.test(l)));
  check('sem exceções nas abas da sala', errs.length === 0, errs.slice(0, 2).join(' || '));
} finally {
  for (const c of chromes) await c.close();
  await svc.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações com a extensão em Chromium real`);
process.exit(failed.length ? 1 : 0);
