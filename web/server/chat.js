/* Mini chat da sala: um botão pequeno no canto, um painel que abre só quando a pessoa quer e um aviso discreto de mensagem nova
   que some sozinho. Nada cobre o centro do vídeo e o foco só vai para o chat se a pessoa abrir. As mensagens ficam só na memória da
   sala (as últimas 30) e somem quando a sala fecha. A lógica é pura e testada à parte; o painel recebe o que enviar e como achar o nome. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoChat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TEXT = 300;
  const BUBBLE_MS = 5000, BUBBLE_CHARS = 110;

  // Troca qualquer caractere de controle por espaço (inclui quebra de linha), junta espaços repetidos e corta no limite
  function cleanText(input) {
    let out = '';
    for (const ch of String(input === undefined || input === null ? '' : input)) {
      const c = ch.codePointAt(0);
      out += c < 32 || c === 127 ? ' ' : ch;
    }
    return out.split(' ').filter(Boolean).join(' ').slice(0, MAX_TEXT);
  }
  /** Mensagens de outras pessoas ainda não vistas. */
  const unreadFrom = (messages, seenId, you) => (Array.isArray(messages) ? messages : []).filter((m) => m && m.id > seenId && m.slot !== you);
  const lastId = (messages) => (Array.isArray(messages) ? messages.reduce((n, m) => Math.max(n, m && Number.isFinite(m.id) ? m.id : 0), 0) : 0);
  const shorten = (text, n = BUBBLE_CHARS) => (text.length > n ? text.slice(0, n - 1) + '…' : text);
  /** Texto do aviso: "Larissa: oi, já vai começar?" */
  const bubbleText = (name, text) => shorten(name + ': ' + text);

  const CSS = [
    '.chat-dock{position:fixed;right:16px;bottom:16px;z-index:2147479000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(320px,calc(100vw - 32px));font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f5f2f5}',
    '.chat-dock[hidden]{display:none}.chat-dock [hidden]{display:none!important}',
    '.chat-toggle{position:relative;min-width:44px;height:44px;padding:0 16px;border-radius:22px;border:1px solid #344050;background:#171E2Bf2;color:#f5f2f5;font:inherit;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 10px 30px #0009;opacity:.8;transition:opacity .2s}',
    '.chat-toggle:hover,.chat-toggle:focus-visible,.chat-dock.is-open .chat-toggle{opacity:1}.chat-toggle:focus-visible,.chat-panel button:focus-visible,.chat-panel input:focus-visible{outline:2px solid #FFAC8F;outline-offset:2px}',
    '.chat-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#FFAC8F;color:#2b1519;font-size:11px;font-weight:800;line-height:18px;text-align:center}',
    '.chat-bubble{max-width:100%;padding:9px 13px;border:1px solid #344050;border-radius:14px;background:#171E2Bee;box-shadow:0 10px 30px #0009;cursor:pointer;overflow-wrap:anywhere;animation:chat-pop .25s ease-out}',
    '@keyframes chat-pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}:where(:root[data-motion="reduced"],:root[data-motion="off"]) .chat-bubble{animation:none}',
    '.chat-panel{width:min(300px,calc(100vw - 32px));display:flex;flex-direction:column;border:1px solid #344050;border-radius:16px;background:#171E2Bf5;box-shadow:0 18px 50px #000b;overflow:hidden}',
    '.chat-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid #2a3344;font-weight:700}',
    '.chat-head button{border:0;background:none;color:#a9b2c2;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px}',
    '.chat-list{list-style:none;margin:0;padding:8px 12px;max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:6px}',
    '.chat-list li{overflow-wrap:anywhere}.chat-list b{color:#FFAC8F;margin-right:6px}.chat-list .mine b{color:#9be8b9}.chat-empty{color:#a9b2c2}',
    '.chat-form{display:flex;gap:6px;padding:8px;border-top:1px solid #2a3344}',
    '.chat-form input{flex:1;min-width:0;font:inherit;color:#f5f2f5;background:#0b101c;border:1px solid #344050;border-radius:999px;padding:7px 12px}',
    '.chat-form button{font:inherit;font-weight:700;cursor:pointer;border:0;border-radius:999px;padding:7px 12px;background:#FFAC8F;color:#2b1519}',
    '.chat-err{margin:0;padding:0 12px 8px;color:#ff9d9d;font-size:12px}',
  ].join('');

  /** O painel. `send(text)` devolve uma promessa; `nameFor(papel)` devolve o nome a mostrar. */
  function createDock({ doc, send, nameFor, setTimer, clearTimer } = {}) {
    const win = doc.defaultView || {};
    const later = setTimer || ((fn, ms) => win.setTimeout(fn, ms));
    const clear = clearTimer || ((t) => win.clearTimeout(t));
    const style = doc.createElement('style'); style.textContent = CSS; doc.head.append(style);
    const el = (tag, attrs = {}, text) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text !== undefined) n.textContent = text; return n; };

    const root = el('div', { class: 'chat-dock' }); root.hidden = true;
    const bubble = el('div', { class: 'chat-bubble', role: 'status', 'aria-live': 'polite' }); bubble.hidden = true;
    const panel = el('section', { class: 'chat-panel', 'aria-label': 'Chat da sala' }); panel.hidden = true;
    const close = el('button', { type: 'button', 'aria-label': 'Fechar o chat' }, '×');
    const head = el('div', { class: 'chat-head' }); head.append(el('span', {}, 'Chat da sala'), close);
    const list = el('ul', { class: 'chat-list' });
    const form = el('form', { class: 'chat-form', autocomplete: 'off' });
    const input = el('input', { type: 'text', maxlength: String(MAX_TEXT), placeholder: 'Escreva uma mensagem', 'aria-label': 'Mensagem' });
    const sendBtn = el('button', { type: 'submit' }, 'Enviar');
    form.append(input, sendBtn);
    const err = el('p', { class: 'chat-err', role: 'alert' }); err.hidden = true;
    panel.append(head, list, form, err);
    const toggle = el('button', { type: 'button', class: 'chat-toggle', 'aria-label': 'Chat da sala', 'aria-expanded': 'false' }, '\u{1F4AC} Chat');
    const badge = el('span', { class: 'chat-badge', 'aria-hidden': 'true' }); badge.hidden = true;
    toggle.append(badge);
    root.append(bubble, panel, toggle);
    doc.body.append(root);

    let isOpen = false, active = false, messages = [], you = null, seenId = 0, notifiedId = 0, bubbleTimer = null, fresh = true, renderedKey = '';

    const hideBubble = () => { if (bubbleTimer) clear(bubbleTimer); bubbleTimer = null; bubble.hidden = true; };
    function render() {
      const key = messages.map((m) => m.id).join(',') + '|' + you;
      if (key === renderedKey) return;
      renderedKey = key;
      list.replaceChildren();
      if (!messages.length) { list.append(el('li', { class: 'chat-empty' }, 'Ninguém escreveu ainda.')); return; }
      for (const m of messages) {
        const li = el('li', m.slot === you ? { class: 'mine' } : {});
        li.append(el('b', {}, m.slot === you ? 'Você' : nameFor(m.slot)), doc.createTextNode(m.text));
        list.append(li);
      }
      list.scrollTop = list.scrollHeight;
    }
    function paintBadge() {
      const n = unreadFrom(messages, seenId, you).length;
      badge.hidden = n === 0; badge.textContent = n > 9 ? '9+' : String(n);
      toggle.setAttribute('aria-label', n ? 'Chat da sala, ' + n + ' mensagem' + (n > 1 ? 's' : '') + ' nova' + (n > 1 ? 's' : '') : 'Chat da sala');
    }
    function open() {
      if (!active) return;
      isOpen = true; panel.hidden = false; root.classList.add('is-open'); toggle.setAttribute('aria-expanded', 'true');
      hideBubble(); seenId = lastId(messages); render(); paintBadge(); list.scrollTop = list.scrollHeight;
      input.focus({ preventScroll: true });
    }
    function closePanel(returnFocus) {
      isOpen = false; panel.hidden = true; root.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false');
      if (returnFocus) toggle.focus({ preventScroll: true });
    }
    toggle.addEventListener('click', () => (isOpen ? closePanel(false) : open()));
    close.addEventListener('click', () => closePanel(true));
    bubble.addEventListener('click', open);
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(true); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = cleanText(input.value);
      if (!text) return;
      err.hidden = true; sendBtn.disabled = true;
      try { await send(text); input.value = ''; }
      catch (error) { err.textContent = error && error.code === 'rate_limited' ? 'Calma, uma mensagem por vez.' : 'Não enviou. Tente de novo.'; err.hidden = false; }
      finally { sendBtn.disabled = false; input.focus({ preventScroll: true }); }
    });

    /** Chamado a cada atualização da sala. Com `active: false` o chat some e o histórico local é esquecido. */
    function update(state = {}) {
      const nowActive = !!state.active;
      if (!nowActive) {
        if (active) { active = false; messages = []; seenId = 0; notifiedId = 0; fresh = true; renderedKey = ''; hideBubble(); closePanel(false); root.hidden = true; }
        return;
      }
      active = true; root.hidden = false; you = state.you || null;
      messages = Array.isArray(state.messages) ? state.messages : [];
      const newest = lastId(messages);
      if (fresh) { seenId = newest; notifiedId = newest; fresh = false; }          // primeira vez nesta sala: o passado não vira aviso
      render();
      if (isOpen) { seenId = newest; notifiedId = newest; paintBadge(); list.scrollTop = list.scrollHeight; return; }
      const news = unreadFrom(messages, notifiedId, you);
      if (news.length) {
        const m = news[news.length - 1];
        notifiedId = newest;
        bubble.textContent = bubbleText(nameFor(m.slot), m.text); bubble.hidden = false;
        if (bubbleTimer) clear(bubbleTimer);
        bubbleTimer = later(() => { bubbleTimer = null; bubble.hidden = true; }, BUBBLE_MS);
      }
      paintBadge();
    }
    return { update, open, close: () => closePanel(false), el: root, isOpen: () => isOpen };
  }

  return { createDock, cleanText, unreadFrom, lastId, bubbleText, shorten, MAX_TEXT, BUBBLE_MS };
});
