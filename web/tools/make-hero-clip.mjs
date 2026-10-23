// Grava um clipe de ~10 s do app de verdade (Host criando a sala, o convidado entrando, chat e reações) para a página de apresentação.
// Tudo local, com dados fictícios (catálogo de demonstração) e sem rede: nenhum filme, cartaz ou serviço de streaming aparece.
// Uso: node tools/make-hero-clip.mjs [saida.webm] [--frames pasta]   (sem ffmpeg: os quadros viram vídeo num canvas do próprio Chromium)
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launch } from './cdp.mjs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');

const out = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '../docs/midia/dalari-intro.webm');
const framesDir = process.argv.includes('--frames') ? path.resolve(process.argv[process.argv.indexOf('--frames') + 1]) : null;
const W = 1280, H = 720, FPS = 20, SECONDS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const svc = createRoomService({ servePrototype: true, logger: () => {} });
const addr = await svc.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${addr.port}`;
const chrome = await launch({ args: [`--window-size=${W},${H}`] });
try {
  const mk = async () => {
    const { browserContextId } = await chrome.browser.send('Target.createBrowserContext');
    const p = await chrome.browser.page(null, { contextId: browserContextId });
    await p.call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await p.goto(origin + '/');
    await p.evaluate(() => { localStorage.setItem('duotela-welcome-v4', '1'); localStorage.setItem('duotela-audio-wizard-v1', '1'); localStorage.setItem('duotela-telemetry', 'off'); localStorage.setItem('duotela-motion', 'full'); });
    await p.goto(origin + '/');
    await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    return p;
  };
  const host = await mk(), guest = await mk();
  const click = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); if (!n) throw new Error('sem ' + s); n.click(); return true; }, sel);
  const setVal = (p, sel, v) => p.evaluate((s, val) => { const n = document.querySelector(s); n.value = val; n.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);

  // cursor e "clique" visíveis só no vídeo (o screencast não mostra o ponteiro do sistema)
  await host.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '#fakecur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.3,.7,.2,1);transform:translate(640px,360px)}#fakecur svg{filter:drop-shadow(0 2px 3px #0008)}#fakecur i{position:absolute;left:-14px;top:-14px;width:50px;height:50px;border-radius:50%;border:3px solid #FFAC8F;opacity:0;transform:scale(.3)}#fakecur.tap i{animation:tap .45s ease-out}@keyframes tap{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.15)}}';
    document.head.append(s);
    const c = document.createElement('div'); c.id = 'fakecur';
    c.innerHTML = '<i></i><svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8-6 2 4 7-3 1-4-7-5 4z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    document.body.append(c);
  });
  const move = async (sel) => {
    await host.evaluate((s) => { const n = document.querySelector(s); if (!n) throw new Error('sem ' + s); const r = n.getBoundingClientRect(); document.querySelector('#fakecur').style.transform = `translate(${Math.round(r.left + Math.min(r.width / 2, 120))}px,${Math.round(r.top + r.height / 2)}px)`; }, sel);
    await sleep(520);
  };
  const tapClick = async (sel) => { await move(sel); await host.evaluate(() => { const c = document.querySelector('#fakecur'); c.classList.remove('tap'); void c.offsetWidth; c.classList.add('tap'); }); await sleep(120); await click(host, sel); };
  const typeInto = async (p, sel, text, ms = 70) => { for (let i = 1; i <= text.length; i++) { await setVal(p, sel, text.slice(0, i)); await sleep(ms); } };

  // prepara o Host na aba Sala (fora do vídeo)
  await host.evaluate(() => document.querySelector('[data-view="room"]').click());
  await host.waitFor(() => !!document.querySelector('[data-online-act=create]'));
  await guest.evaluate(() => document.querySelector('[data-view="room"]').click());
  await guest.waitFor(() => !!document.querySelector('[data-online-act=join]'));
  await sleep(400);

  // ---------- gravação ----------
  const frames = [];
  let t0 = null;
  host.cdp.on((m) => {
    if (m.sessionId !== host.sessionId || m.method !== 'Page.screencastFrame') return;
    const ts = m.params.metadata.timestamp * 1000;
    if (t0 === null) t0 = ts;
    frames.push({ at: ts - t0, data: m.params.data });
    host.call('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  });
  await host.call('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const started = Date.now();

  await sleep(700);
  await typeInto(host, '#online-display-name', 'Ana');
  await tapClick('[data-online-act=create]');
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.status === 'active');
  await sleep(500);
  // convite (a pessoa entra pelo código)
  await click(host, '#rv3-invite-btn');
  await host.waitFor(() => !!document.querySelector('#rv3-invite-dialog[open]'));
  if (await host.evaluate(() => !!document.querySelector('#rv3-invite-dialog [data-online-act=invite]'))) {
    await click(host, '#rv3-invite-dialog [data-online-act=invite]');
    await host.waitFor(() => !!document.querySelector('#rv3-invite-field'));
  }
  const invite = await host.evaluate(() => document.querySelector('#rv3-invite-field').value);
  await sleep(1100);
  await host.evaluate(() => document.querySelector('#rv3-invite-dialog').close());
  await setVal(guest, '#online-display-name', 'Beto');
  await setVal(guest, '#online-invite-input', invite);
  await click(guest, '[data-online-act=join]');
  await host.waitFor(() => !!document.querySelector('#rv3-alert [data-online-act=approve]'));
  await sleep(500);
  await tapClick('#rv3-alert [data-online-act=approve]');
  await host.waitFor(() => window.DuoTelaOnline.snapshot?.participants?.length === 2);
  await sleep(500);
  // chat e reação
  await click(host, '.chat-toggle');
  await sleep(300);
  await typeInto(host, '.chat-form input', 'Oi Beto, já vai começar?', 45);
  await host.evaluate(() => document.querySelector('.chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await sleep(500);
  await setVal(guest, '.chat-form input', 'Já! Pipoca pronta 🍿');
  await guest.evaluate(() => { document.querySelector('.chat-toggle').click(); });
  await guest.evaluate(() => document.querySelector('.chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await sleep(500);
  await click(host, '.chat-toggle');
  await tapClick('[data-online-act=react][data-emoji="heart"]');
  await sleep(350);
  await click(guest, '[data-online-act=react][data-emoji="popcorn"]');
  await sleep(900);
  const used = (Date.now() - started) / 1000;
  while ((Date.now() - started) / 1000 < SECONDS + 0.2) await sleep(100);
  await host.call('Page.stopScreencast');
  console.log(`gravado: ${frames.length} quadros em ${used.toFixed(1)} s (alvo ${SECONDS} s)`);
  if (!frames.length) throw new Error('nenhum quadro gravado');

  // reamostra em FPS fixo: para cada instante, o último quadro já recebido
  const total = Math.min(SECONDS, (frames.at(-1).at / 1000) + 0.3);
  const n = Math.round(total * FPS), picked = [];
  let j = 0;
  for (let i = 0; i < n; i++) { const t = (i / FPS) * 1000; while (j + 1 < frames.length && frames[j + 1].at <= t) j++; picked.push(frames[j].data); }
  if (framesDir) { await mkdir(framesDir, { recursive: true }); for (const [i, d] of picked.entries()) await writeFile(path.join(framesDir, `f${String(i).padStart(3, '0')}.jpg`), Buffer.from(d, 'base64')); }

  // monta o WebM no próprio Chromium: desenha os quadros num canvas e grava com MediaRecorder (sem ffmpeg)
  const enc = await chrome.browser.page();
  await enc.goto('about:blank');
  const b64 = await enc.evaluate(async (list, w, h, fps) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h }); const ctx = canvas.getContext('2d');
    const imgs = await Promise.all(list.map((d) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = 'data:image/jpeg;base64,' + d; })));
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(canvas.captureStream(fps), { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    ctx.drawImage(imgs[0], 0, 0, w, h); rec.start(200);
    for (const im of imgs) { ctx.drawImage(im, 0, 0, w, h); await new Promise((r) => setTimeout(r, 1000 / fps)); }
    await new Promise((r) => setTimeout(r, 150)); rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, picked, W, H, FPS);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(b64, 'base64'));
  console.log('vídeo salvo em', out, (Buffer.from(b64, 'base64').length / 1024).toFixed(0) + ' KB');
} finally { await chrome.close(); await svc.close(); }
