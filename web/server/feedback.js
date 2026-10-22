/* Canal de feedback: uma mensagem curta que chega direto ao criador. Só sai quando a pessoa clica em Enviar, e a janela mostra
   exatamente o que vai junto. Não depende das estatísticas anônimas estarem ligadas, mas usa o mesmo serviço (stats-config.json).
   A lógica (validar, montar, enviar) é pura e testada à parte; a janela só liga isso à tela. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DuoFeedback = api; if (typeof document !== 'undefined') api.install(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KINDS = [
    ['ideia', 'Sugestão ou ideia'],
    ['problema', 'Problema'],
    ['elogio', 'Elogio'],
    ['outro', 'Outro assunto'],
  ];
  const MAX_MESSAGE = 1000, MAX_CONTACT = 100, MIN_MESSAGE = 3;
  const COOLDOWN_MS = 30000, TIMEOUT_MS = 10000;
  const APP_RE = /^[0-9A-Za-z.+-]{1,20}$/;
  const OS_KEYS = ['win', 'mac', 'linux', 'other'];

  const MESSAGES = {
    empty: 'Escreva ao menos uma frase curta.',
    too_long: 'A mensagem passou de ' + MAX_MESSAGE + ' caracteres. Resuma um pouco.',
    contact_long: 'O contato passou de ' + MAX_CONTACT + ' caracteres.',
    kind: 'Escolha o tipo da mensagem.',
    unavailable: 'Esta versão não tem o canal de feedback ligado. Você pode escrever nas "issues" do GitHub.',
    too_soon: 'Aguarde alguns segundos antes de enviar outra mensagem.',
    rate_limited: 'Você já enviou algumas mensagens agora há pouco. Tente de novo daqui a uma hora.',
    daily_limit: 'O canal recebeu muitas mensagens hoje. Tente de novo amanhã.',
    network: 'Não consegui falar com o serviço. Confira a internet e tente de novo; o texto continua aqui.',
    server: 'O serviço não conseguiu entregar agora. Tente de novo daqui a pouco; o texto continua aqui.',
  };
  // Problemas que o app percebe sozinho (os mesmos códigos das estatísticas). A pessoa só vê um aviso com o botão Reportar.
  const PROBLEMS = {
    player_fail: 'o vídeo do YouTube não abriu',
    room_lost: 'a sala caiu e não voltou',
    update_fail: 'a atualização automática falhou',
    unexpected: 'ocorreu um erro inesperado no app',
    mic_denied: 'o microfone está bloqueado',
    mic_missing: 'não achei nenhum microfone',
    mic_busy: 'o microfone está em uso por outro programa',
    mic_insecure: 'a página não tem permissão de microfone',
  };
  const SILENT_PROBLEMS = ['mic_denied'];           // já explicado na própria tela de voz: fica guardado, mas sem aviso
  const TOAST_AGAIN_MS = 5 * 60000, TOAST_SHOW_MS = 14000, RECENT_MS = 10 * 60000;
  const problemLabel = (code) => (Object.hasOwn(PROBLEMS, code) ? PROBLEMS[code] : null);
  const pad2 = (n) => String(n).padStart(2, '0');
  /** O texto já preenchido no relatório de um problema: o que o app viu e uma linha para a pessoa contar o resto. */
  function problemReport(code, at) {
    const label = problemLabel(code); if (!label) return '';
    const d = new Date(at);
    return 'O app avisou que ' + label + ' (às ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ').\n\nO que eu estava fazendo: ';
  }

  const friendly = (reason) => MESSAGES[reason] || MESSAGES.server;

  /** { ok: true } ou { ok: false, reason } para o que a pessoa digitou. */
  function validate({ kind, message, contact } = {}) {
    if (!KINDS.some(([k]) => k === kind)) return { ok: false, reason: 'kind' };
    const text = typeof message === 'string' ? message.trim() : '';
    if (text.length < MIN_MESSAGE) return { ok: false, reason: 'empty' };
    if (text.length > MAX_MESSAGE) return { ok: false, reason: 'too_long' };
    if (contact !== undefined && contact !== null && String(contact).trim().length > MAX_CONTACT) return { ok: false, reason: 'contact_long' };
    return { ok: true };
  }

  /** O corpo exato enviado ao serviço. Versão e sistema só entram se a pessoa deixou marcado. */
  function buildPayload({ kind, message, contact, includeInfo }, { version, os } = {}) {
    const p = { v: 1, kind, message: String(message).trim() };
    const c = contact ? String(contact).trim().replace(/\s+/g, ' ') : '';
    if (c) p.contact = c;
    if (includeInfo) {
      if (typeof version === 'string' && APP_RE.test(version) && version !== 'dev') p.app = version;
      if (OS_KEYS.includes(os)) p.os = os;
    }
    return p;
  }

  let lastSentAt = 0;
  /** Envia. Devolve { ok: true } ou { ok: false, reason } (reason em MESSAGES). */
  async function send(payload, { url, fetchImpl, now = Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
    if (!url || typeof fetchImpl !== 'function') return { ok: false, reason: 'unavailable' };
    if (now - lastSentAt < COOLDOWN_MS) return { ok: false, reason: 'too_soon' };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(String(url).replace(/\/+$/, '') + '/v1/feedback', {
        method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}),
      });
      if (res && res.ok) { lastSentAt = now; return { ok: true }; }
      let error = ''; try { error = (await res.json())?.error || ''; } catch { /* sem corpo */ }
      if (res?.status === 429) return { ok: false, reason: error === 'daily_limit' ? 'daily_limit' : 'rate_limited' };
      return { ok: false, reason: 'server' };
    } catch { return { ok: false, reason: 'network' }; }
    finally { if (timer) clearTimeout(timer); }
  }
  const resetCooldown = () => { lastSentAt = 0; };

  function install(win) {
    const doc = win.document;
    let lastProblem = null, toastEl = null, toastTimer = null;
    const toastedAt = {};
    const style = doc.createElement('style');
    style.textContent = '.fb-field{display:block;margin:12px 0 0}.fb-field>span{display:block;margin-bottom:4px;font-weight:700;color:#FFAC8F;font-size:13px}'
      + '.fb-field select,.fb-field textarea,.fb-field input[type=text]{width:100%;box-sizing:border-box;font:inherit;color:#f5f2f5;background:#0b101c;border:1px solid #344050;border-radius:12px;padding:9px 12px}'
      + '.fb-field textarea{min-height:120px;resize:vertical}.fb-field select:focus-visible,.fb-field textarea:focus-visible,.fb-field input:focus-visible{outline:2px solid #FFAC8F;outline-offset:1px}'
      + '.fb-toast{position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));padding:10px 12px 10px 16px;border:1px solid #344050;border-radius:16px;background:#171E2Bf2;color:#f5f2f5;box-shadow:0 14px 40px #000a;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}'
      + '.fb-toast-go{font:inherit;font-weight:700;cursor:pointer;border:0;border-radius:999px;padding:7px 14px;background:#FFAC8F;color:#2b1519}.fb-toast-x{font:inherit;cursor:pointer;border:0;background:none;color:#a9b2c2;font-size:18px;line-height:1;padding:2px 6px}'
      + '.fb-toast-go:focus-visible,.fb-toast-x:focus-visible,.side-feedback:focus-visible{outline:2px solid #FFAC8F;outline-offset:2px}'
      + '.side-feedback{display:block;width:100%;margin:0 0 8px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;text-align:left;border:1px solid #344050;border-radius:12px;padding:9px 12px;background:#202838;color:#f2f4f8}.side-feedback:hover{filter:brightness(1.1)}'
      + '.fb-count{display:block;margin-top:3px;font-size:12px;color:#a9b2c2;text-align:right}.fb-count.over{color:#ff9d9d}'
      + '.fb-check{display:flex;gap:8px;align-items:flex-start;margin:14px 0 0;color:#d6dbe6}.fb-check input{margin-top:3px}'
      + '.fb-note{margin:8px 0 0;font-size:12px;color:#a9b2c2}.fb-status{min-height:20px;margin:12px 0 0;font-weight:700}.fb-status.err{color:#ff9d9d}.fb-status.ok{color:#9be8b9}';
    doc.head.append(style);

    const el = (tag, text, attrs = {}) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    let dialog = null;
    const close = () => { const d = dialog; dialog = null; if (d) { try { d.close(); } catch { /* já fechado */ } d.remove(); } };

    function openLink(url) {
      if (win.duoDesktop?.openExternal) win.duoDesktop.openExternal(url);
      else win.open(url, '_blank', 'noopener,noreferrer');
    }
    const telemetry = () => win.DuoTelemetry?.shared?.() || null;
    const environment = () => { const t = telemetry(); return { version: t?.config?.version, os: win.DuoTelemetry?.osOf?.(win.navigator) || 'other' }; };

    // Um problema detectado pelo app: guarda e, se o canal existe, mostra um aviso pequeno com o botão Reportar (um clique abre o relatório pronto).
    function problem(code, now = Date.now()) {
      if (!problemLabel(code)) return;
      lastProblem = { code, at: now };
      const t = telemetry();
      if (!t?.available || SILENT_PROBLEMS.includes(code) || now - (toastedAt[code] || 0) < TOAST_AGAIN_MS) return;
      toastedAt[code] = now;
      hideToast();
      toastEl = el('div', undefined, { class: 'fb-toast', role: 'status', 'aria-live': 'polite' });
      const msg = el('span', 'Algo deu errado: ' + problemLabel(code) + '.');
      const go = el('button', 'Reportar', { type: 'button', class: 'fb-toast-go' }); go.addEventListener('click', () => { hideToast(); show({ kind: 'problema', message: problemReport(code, now) }); });
      const no = el('button', '×', { type: 'button', class: 'fb-toast-x', 'aria-label': 'Dispensar' }); no.addEventListener('click', hideToast);
      toastEl.append(msg, go, no); doc.body.append(toastEl);
      toastTimer = win.setTimeout(hideToast, TOAST_SHOW_MS);
    }
    function hideToast() { if (toastTimer) win.clearTimeout(toastTimer); toastTimer = null; toastEl?.remove(); toastEl = null; }

    function show(opts = {}) {
      if (!opts.message && !opts.kind && lastProblem && Date.now() - lastProblem.at < RECENT_MS) opts = { kind: 'problema', message: problemReport(lastProblem.code, lastProblem.at) };
      close();
      dialog = el('dialog', undefined, { class: 'duo-dialog', 'aria-labelledby': 'fb-title' });
      dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; });
      dialog.append(el('h2', 'Falar com o criador', { id: 'fb-title' }), el('p', 'Uma sugestão, um problema ou um elogio chega direto ao Daniel. Só é enviado quando você clica em Enviar.', { class: 'lead' }));

      const t = telemetry();
      const url = t?.config?.url || '';
      if (!url || !t?.available) {
        dialog.append(el('p', 'Esta versão não tem o canal de feedback ligado. Você pode escrever nas "issues" do GitHub.'));
        const row = el('div', undefined, { class: 'duo-actions' });
        const gh = el('button', 'Abrir o GitHub', { type: 'button', class: 'duo-btn main' }); gh.addEventListener('click', () => openLink(win.DuoFirstRun?.LINKS?.repo || 'https://github.com/ysauron2/dalari-cine'));
        const x = el('button', 'Fechar', { type: 'button', class: 'duo-btn' }); x.addEventListener('click', close);
        row.append(gh, x); dialog.append(row);
        doc.body.append(dialog); dialog.showModal(); return;
      }

      const kind = el('select', undefined, { id: 'fb-kind' });
      for (const [k, label] of KINDS) kind.append(el('option', label, { value: k }));
      const HINTS = { ideia: 'Que ideia ou melhoria você sugere? Pode ser pequena.', problema: 'O que aconteceu? O que você estava fazendo?', elogio: 'O que você mais gostou?', outro: 'Escreva o que quiser.' };
      const text = el('textarea', undefined, { id: 'fb-text', maxlength: String(MAX_MESSAGE + 200), placeholder: HINTS.ideia });
      if (KINDS.some(([k]) => k === opts.kind)) kind.value = opts.kind;
      if (typeof opts.message === 'string') text.value = opts.message.slice(0, MAX_MESSAGE);
      const setHint = () => { text.placeholder = HINTS[kind.value] || HINTS.outro; }; kind.addEventListener('change', setHint); setHint();
      const count = el('span', '0 / ' + MAX_MESSAGE, { class: 'fb-count' });
      const contact = el('input', undefined, { id: 'fb-contact', type: 'text', maxlength: String(MAX_CONTACT + 50), autocomplete: 'off', placeholder: 'E-mail ou @ (opcional, só se quiser resposta)' });
      const info = el('input', undefined, { id: 'fb-info', type: 'checkbox' }); info.checked = true;
      const status = el('p', '', { class: 'fb-status', role: 'status', 'aria-live': 'polite' });
      const preview = el('p', '', { class: 'fb-note' });

      const field = (label, control, extra) => { const l = el('label', undefined, { class: 'fb-field' }); l.append(el('span', label), control); if (extra) l.append(extra); return l; };
      dialog.append(field('Tipo', kind), field('Mensagem', text, count), field('Contato (opcional)', contact));
      const check = el('label', undefined, { class: 'fb-check' }); check.append(info, el('span', 'Incluir a versão do app e o sistema (ajuda a achar o problema)'));
      dialog.append(check, preview, status);

      const env = () => environment();
      const current = () => ({ kind: kind.value, message: text.value, contact: contact.value, includeInfo: info.checked });
      const refresh = () => {
        const n = text.value.trim().length;
        count.textContent = n + ' / ' + MAX_MESSAGE; count.classList.toggle('over', n > MAX_MESSAGE);
        const e = env();
        const parts = ['o tipo e a sua mensagem'];
        if (contact.value.trim()) parts.push('o contato que você escreveu');
        if (info.checked) parts.push('a versão (' + (e.version && e.version !== 'dev' ? e.version : 'desconhecida') + ') e o sistema');
        preview.textContent = 'Vai junto: ' + parts.join(', ') + '. Nada mais: sem nome, sem identificador da instalação, sem o que você assiste.';
      };
      for (const c of [kind, text, contact, info]) c.addEventListener('input', refresh);
      refresh();

      const row = el('div', undefined, { class: 'duo-actions' });
      const sendBtn = el('button', 'Enviar', { type: 'button', class: 'duo-btn main' });
      const cancel = el('button', 'Cancelar', { type: 'button', class: 'duo-btn' });
      cancel.addEventListener('click', close);
      sendBtn.addEventListener('click', async () => {
        const v = validate(current());
        status.className = 'fb-status';
        if (!v.ok) { status.textContent = friendly(v.reason); status.classList.add('err'); (v.reason === 'kind' ? kind : text).focus(); return; }
        sendBtn.disabled = true; status.textContent = 'Enviando…';
        const r = await send(buildPayload(current(), env()), { url, fetchImpl: win.fetch.bind(win) });
        if (r.ok) {
          status.textContent = 'Enviado! Obrigado, a mensagem chegou ao Daniel.'; status.classList.add('ok');
          cancel.textContent = 'Fechar'; text.disabled = kind.disabled = contact.disabled = info.disabled = true; sendBtn.hidden = true;
        } else { status.textContent = friendly(r.reason); status.classList.add('err'); sendBtn.disabled = false; }
      });
      row.append(sendBtn, cancel); dialog.append(row);
      doc.body.append(dialog); dialog.showModal(); dialog.scrollTop = 0; text.focus({ preventScroll: true });
      text.setSelectionRange(text.value.length, text.value.length); refresh();
    }

    doc.addEventListener('click', (e) => { if (e.target.closest?.('[data-duo-open=feedback]')) show(); });
    win.DuoFeedback.show = show; win.DuoFeedback.problem = problem;
  }

  return { install, validate, buildPayload, send, friendly, resetCooldown, problemLabel, problemReport, PROBLEMS, KINDS, MAX_MESSAGE, MAX_CONTACT, COOLDOWN_MS, MESSAGES };
});
