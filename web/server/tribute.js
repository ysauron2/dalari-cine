/* Homenagem à Larissa: cena animada em 3D (CSS puro, sem bibliotecas), aberta com um clique em Perfil → Sobre e créditos →
   "Ver a homenagem" (nunca aparece sozinha). As letras D e L se aproximam, viram um coração que gira, e o texto aparece.
   Respeita "reduzir movimento" (mostra a cena final parada). O texto é HTML de verdade, legível por leitores de tela. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoTribute = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FLAG_KEY = 'duotela-tribute-v1';
  const TEXT = {
    title: 'Dalari',
    names: ['Daniel', 'Larissa'],
    line: 'Em homenagem a Larissa B., que incentivou o Daniel a criar este app para assistirem juntos, mesmo à distância.',
    by: 'Criado por Daniel Didini (Kaizen)',
    button: 'Continuar',
  };

  const storage = (win) => { try { return win.localStorage; } catch { return null; } };
  const hasSeen = (win) => { try { return storage(win)?.getItem(FLAG_KEY) === '1'; } catch { return false; } };
  const markSeen = (win) => { try { storage(win)?.setItem(FLAG_KEY, '1'); } catch { /* sem armazenamento: aparece de novo na próxima abertura */ } };

  const FRAMES = 14, STARS = 28, HEART_LAYERS = 11;

  function css() {
    return '.duo-tribute{width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;overflow:hidden;color:#f5f2f5;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;'
      + 'background:radial-gradient(ellipse at 50% 38%,#2a2140 0%,#12182a 55%,#070a12 100%)}'
      + '.duo-tribute::backdrop{background:#05070c}'
      + '.tb-stars{position:absolute;inset:0;pointer-events:none}.tb-stars u{position:absolute;left:var(--x);top:var(--y);width:var(--s);height:var(--s);border-radius:50%;background:#ffd9c8;opacity:.0;animation:tb-twinkle var(--d) ease-in-out infinite;animation-delay:var(--l)}'
      + '.tb-scene{position:absolute;left:0;right:0;top:0;height:58%;perspective:1000px;perspective-origin:50% 45%}'
      + '.tb-world{position:absolute;inset:0;transform-style:preserve-3d;transform:rotateX(calc(-27deg + var(--rx,0deg))) rotateY(var(--ry,0deg));transition:transform .25s ease-out}'
      + '.tb-ring{position:absolute;left:50%;top:52%;width:0;height:0;transform-style:preserve-3d;animation:tb-ringin 1.8s cubic-bezier(.2,.8,.2,1) backwards,tb-spin 22s linear 1.8s infinite}'
      + '.tb-frame{position:absolute;left:-38px;top:-25px;width:76px;height:50px;box-sizing:border-box;border:2px solid #ffac8fcc;border-radius:9px;background:linear-gradient(135deg,#ffac8f38,#f58fb41c);box-shadow:0 0 18px #ffac8f55,inset 0 0 12px #ffac8f33;'
      + 'transform:rotateY(calc(var(--i)*25.714deg)) translateZ(250px);animation:tb-fin 1.4s ease-out backwards}'
      + '.tb-frame::before,.tb-frame::after{content:"";position:absolute;left:5px;right:5px;height:4px;background:repeating-linear-gradient(90deg,#ffac8fcc 0 5px,transparent 5px 11px);border-radius:2px}.tb-frame::before{top:3px}.tb-frame::after{bottom:3px}'
      + '.tb-letter{position:absolute;left:50%;top:52%;width:96px;height:96px;margin:-48px 0 0 -48px;display:grid;place-items:center;border-radius:24px;font:800 56px/1 system-ui,"Segoe UI",sans-serif;color:#2b1519;'
      + 'background:linear-gradient(135deg,#ffac8f,#f58fb4);box-shadow:0 18px 50px #f58fb455,inset 0 2px 0 #fff6,inset 0 -6px 14px #0002;opacity:0;transform-style:preserve-3d}'
      + '.tb-d{animation:tb-d 4.4s cubic-bezier(.45,.05,.25,1) .5s both}.tb-l{animation:tb-l 4.4s cubic-bezier(.45,.05,.25,1) .5s both}'
      + '.tb-heart{position:absolute;left:50%;top:52%;width:0;height:0;transform-style:preserve-3d;animation:tb-heartin 1.2s cubic-bezier(.2,1.4,.3,1) 4.3s both,tb-hspin 9s ease-in-out 5.5s infinite}'
      + '.tb-pulse{position:absolute;left:0;top:0;width:0;height:0;transform-style:preserve-3d;animation:tb-beat 1.3s ease-in-out 5.5s infinite}'
      + '.tb-heart b{position:absolute;left:0;top:0;font:400 190px/1 "Segoe UI Symbol","Apple Symbols",system-ui,sans-serif;transform:translate(-50%,-52%) translateZ(calc(var(--z)*1px));color:hsl(342 88% calc(var(--l)*1%));text-shadow:0 0 28px #f58fb466}'
      + '.tb-copy{position:absolute;left:0;right:0;bottom:0;height:42%;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;padding:0 24px;text-align:center}'
      + '.tb-copy>*{margin:0;opacity:0;transform:translateY(14px);animation:tb-up .9s ease-out forwards}'
      + '.tb-copy h2{font-size:clamp(34px,6vw,58px);letter-spacing:-.03em;line-height:1.05;background:linear-gradient(90deg,#ffac8f,#f58fb4);-webkit-background-clip:text;background-clip:text;color:transparent;animation-delay:4.4s}'
      + '.tb-names{font-size:17px;letter-spacing:.14em;text-transform:uppercase;color:#d6dbe6;animation-delay:4.9s}.tb-names span{color:#f58fb4;margin:0 6px}'
      + '.tb-line{max-width:560px;color:#f1eef2;animation-delay:5.5s}.tb-by{font-size:13px;color:#a9b2c2;animation-delay:6.2s}'
      + '.tb-go{margin-top:12px;font:inherit;font-weight:700;cursor:pointer;border-radius:999px;padding:10px 26px;border:0;background:#FFAC8F;color:#2b1519;opacity:0;animation:tb-up .8s ease-out 6.6s forwards}'
      + '.tb-go:hover{filter:brightness(1.08)}.tb-go:focus-visible{outline:2px solid #fff;outline-offset:3px}'
      + '.tb-skip{position:absolute;right:18px;top:16px;font:inherit;font-size:13px;color:#a9b2c2;background:#ffffff10;border:1px solid #ffffff22;border-radius:999px;padding:6px 14px;cursor:pointer;opacity:0;animation:tb-fade .6s ease-out 1s forwards}.tb-skip:hover{color:#fff}'
      + '@keyframes tb-spin{to{transform:rotateY(360deg)}}'
      + '@keyframes tb-ringin{from{transform:scale(.3) rotateY(-120deg)}to{transform:scale(1) rotateY(0)}}@keyframes tb-fin{from{opacity:0}}'
      + '@keyframes tb-d{0%{opacity:0;transform:translate3d(-340px,-30px,-260px) rotateY(-200deg) scale(.5)}18%{opacity:1;transform:translate3d(-150px,-8px,70px) rotateY(0) scale(1)}'
      + '48%{opacity:1;transform:translate3d(-130px,-26px,100px) rotateY(24deg) scale(1.02)}72%{opacity:1;transform:translate3d(-28px,0,40px) rotateY(330deg) scale(.96)}88%{opacity:.9;transform:translate3d(0,0,0) rotateY(540deg) scale(.5)}100%{opacity:0;transform:translate3d(0,0,0) rotateY(720deg) scale(.1)}}'
      + '@keyframes tb-l{0%{opacity:0;transform:translate3d(340px,-30px,-260px) rotateY(200deg) scale(.5)}18%{opacity:1;transform:translate3d(150px,-8px,70px) rotateY(0) scale(1)}'
      + '48%{opacity:1;transform:translate3d(130px,22px,100px) rotateY(-24deg) scale(1.02)}72%{opacity:1;transform:translate3d(28px,0,40px) rotateY(-330deg) scale(.96)}88%{opacity:.9;transform:translate3d(0,0,0) rotateY(-540deg) scale(.5)}100%{opacity:0;transform:translate3d(0,0,0) rotateY(-720deg) scale(.1)}}'
      + '@keyframes tb-heartin{from{transform:scale(0)}to{transform:scale(1)}}'
      + '@keyframes tb-hspin{0%,100%{transform:rotateY(-26deg)}50%{transform:rotateY(26deg)}}'
      + '@keyframes tb-beat{0%,100%{transform:scale(1)}14%{transform:scale(1.07)}28%{transform:scale(1)}42%{transform:scale(1.05)}70%{transform:scale(1)}}'
      + '@keyframes tb-up{to{opacity:1;transform:none}}@keyframes tb-fade{to{opacity:1}}'
      + '@keyframes tb-twinkle{0%,100%{opacity:0;transform:translateY(0) scale(.6)}50%{opacity:.85;transform:translateY(-10px) scale(1)}}'
      + '@media (prefers-reduced-motion:reduce){.duo-tribute:not(.tb-motion) *{animation:none!important;transition:none!important}.duo-tribute:not(.tb-motion) .tb-copy>*,.duo-tribute:not(.tb-motion) .tb-go,.duo-tribute:not(.tb-motion) .tb-skip,.duo-tribute:not(.tb-motion) .tb-replay{opacity:1;transform:none}.duo-tribute:not(.tb-motion) .tb-letter,.duo-tribute:not(.tb-motion) .tb-ring{display:none}.duo-tribute:not(.tb-motion) .tb-stars u{opacity:.5}}'
      + '.tb-replay{position:absolute;left:18px;top:14px;max-width:calc(100% - 140px);text-align:left;font:inherit;font-size:13px;color:#ffd9c8;background:#ffffff10;border:1px solid #ffac8f66;border-radius:999px;padding:7px 16px;cursor:pointer;opacity:1}.tb-replay:hover{background:#ffffff1c}.tb-replay:focus-visible{outline:2px solid #fff;outline-offset:3px}'
      + '@media (max-height:560px){.tb-scene{height:50%}.tb-copy{height:50%}.tb-heart b{font-size:130px}}';
  }

  // Constrói a cena. Separado de show() para poder ser inspecionado/testado com um documento qualquer.
  function build(doc, text = TEXT) {
    const el = (tag, cls, txt) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };
    const dlg = el('dialog', 'duo-tribute');
    dlg.setAttribute('aria-label', 'Homenagem à Larissa');

    const stars = el('div', 'tb-stars'); stars.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < STARS; i++) {
      const u = el('u'), r = (n) => ((i * 9301 + n * 49297) % 233280) / 233280;      // posições fixas, sem Math.random
      u.style.setProperty('--x', Math.round(r(1) * 100) + '%'); u.style.setProperty('--y', Math.round(r(2) * 100) + '%');
      u.style.setProperty('--s', (1.5 + r(3) * 2.5).toFixed(1) + 'px'); u.style.setProperty('--d', (3 + r(4) * 4).toFixed(1) + 's'); u.style.setProperty('--l', (r(5) * 5).toFixed(1) + 's');
      stars.append(u);
    }

    const scene = el('div', 'tb-scene'), world = el('div', 'tb-world'); scene.setAttribute('aria-hidden', 'true');
    const ring = el('div', 'tb-ring');
    for (let i = 0; i < FRAMES; i++) { const f = el('i', 'tb-frame'); f.style.setProperty('--i', String(i)); ring.append(f); }
    const heart = el('div', 'tb-heart'), pulse = el('div', 'tb-pulse');
    for (let i = 0; i < HEART_LAYERS; i++) {
      const b = el('b', undefined, '♥︎'), z = (i - (HEART_LAYERS - 1) / 2) * 3.4;
      b.style.setProperty('--z', z.toFixed(1)); b.style.setProperty('--l', String(Math.round(40 + (i / (HEART_LAYERS - 1)) * 22)));
      pulse.append(b);
    }
    heart.append(pulse);
    world.append(ring, el('div', 'tb-letter tb-d', 'D'), el('div', 'tb-letter tb-l', 'L'), heart);
    scene.append(world);

    const copy = el('div', 'tb-copy');
    const names = el('p', 'tb-names'); names.append(text.names[0], el('span', undefined, '♥︎'), text.names[1]);
    const go = el('button', 'tb-go', text.button); go.type = 'button';
    copy.append(el('h2', undefined, text.title), names, el('p', 'tb-line', text.line), el('p', 'tb-by', text.by), go);
    const skip = el('button', 'tb-skip', 'Pular'); skip.type = 'button';

    dlg.append(stars, scene, copy, skip);
    return { dlg, world, go, skip, copy };
  }

  // Mostra a cena. onClose roda quando a pessoa continua/pula/aperta Esc. Retorna false se já foi vista (e force não foi pedido).
  function show(opts = {}) {
    const win = opts.win || (typeof window !== 'undefined' ? window : null);
    if (!win) return false;
    if (!opts.force && hasSeen(win)) return false;
    const doc = win.document;
    const style = doc.createElement('style'); style.textContent = css(); doc.head.append(style);
    const { dlg, world, go, skip, copy } = build(doc);
    const reduced = !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (opts.motion) dlg.classList.add('tb-motion');
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      markSeen(win);
      try { dlg.close(); } catch { /* já fechado */ }
      dlg.remove(); style.remove();
      opts.onClose?.();
    };
    go.addEventListener('click', finish); skip.addEventListener('click', finish);
    // O sistema pede menos animação: a cena aparece parada, e a pessoa pode escolher ver a animação mesmo assim.
    if (reduced && !opts.motion) {
      const replay = doc.createElement('button'); replay.type = 'button'; replay.className = 'tb-replay';
      replay.textContent = '▶ Ver a animação (seu sistema está com animações reduzidas)';
      replay.addEventListener('click', () => { finish(); show({ ...opts, force: true, motion: true, win }); });
      dlg.append(replay);
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(); });
    // Parallax: a cena inclina levemente com o mouse
    dlg.addEventListener('mousemove', (e) => {
      const w = win.innerWidth || 1, h = win.innerHeight || 1;
      world.style.setProperty('--ry', ((e.clientX / w - 0.5) * 26).toFixed(1) + 'deg');
      world.style.setProperty('--rx', ((e.clientY / h - 0.5) * -16).toFixed(1) + 'deg');
    });
    doc.body.append(dlg);
    dlg.showModal(); dlg.scrollTop = 0;
    win.setTimeout(() => { try { go.focus({ preventScroll: true }); } catch { /* sem foco */ } }, 6700);
    return true;
  }

  return { show, build, hasSeen, markSeen, TEXT, FLAG_KEY };
});
