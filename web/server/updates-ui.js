/* Atualização automática no app de desktop: aviso (toast) quando há versão nova e o cartão "Atualizações" em Perfil.
   Quem verifica, baixa e confere a assinatura é o processo principal do Electron (app/src/updater.cjs); aqui só se mostra
   o estado e se enviam comandos pela ponte window.duoDesktop.updates. No navegador comum esta tela não aparece. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DuoUpdates = api; if (typeof document !== 'undefined') api.install(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pct = (p) => Math.round(Math.min(1, Math.max(0, Number(p) || 0)) * 100);

  // Estado do processo principal -> textos e botões (função pura, testada à parte)
  function describe(s, dismissed) {
    if (!s || typeof s !== 'object') return { line: '', toast: null, canCheck: false, canInstall: false };
    const cur = s.current ? ` (versão ${s.current})` : '';
    const out = { line: '', toast: null, canCheck: !!s.enabled && !['checking', 'downloading', 'installing'].includes(s.status), canInstall: s.status === 'available' };
    // Versão abaixo do mínimo: criar e entrar em salas fica bloqueado até atualizar (o resto do app segue funcionando)
    if (s.required && ['available', 'idle', 'current', 'error', 'checking'].includes(s.status)) {
      out.line = 'Atualização necessária' + (s.version ? ` para a versão ${s.version}` : '') + (s.current ? ` (você tem a ${s.current})` : '') + ': esta versão não cria nem entra em salas.';
      out.toast = { text: 'Atualização necessária', sub: 'Esta versão do Dalari Cine não consegue mais criar nem entrar em salas. O resto do app continua funcionando.', actions: s.status === 'available' ? ['install'] : [] };
      out.canInstall = s.status === 'available';
      return out;
    }
    switch (s.status) {
      case 'checking': out.line = 'Verificando…'; break;
      case 'current': out.line = 'Você está na versão mais recente' + cur + '.'; break;
      case 'available':
        out.line = `Nova versão ${s.version} disponível` + (s.current ? ` (você tem a ${s.current})` : '') + '.';
        if (dismissed !== s.version) out.toast = { text: `Nova versão ${s.version} do Dalari Cine`, sub: 'Atualizar fecha o app e encerra a sala e a chamada abertas. Dá para continuar o filme e atualizar depois.', actions: ['install', 'later'] };
        break;
      case 'downloading': out.line = `Baixando a versão ${s.version}… ${pct(s.progress)}%`; out.toast = { text: `Baixando a versão ${s.version}… ${pct(s.progress)}%`, sub: 'Você pode continuar usando o app.', actions: [] }; break;
      case 'installing': out.line = 'Instalando: o Dalari Cine vai fechar e abrir de novo sozinho.'; out.toast = { text: 'Instalando a atualização…', sub: 'O Dalari Cine vai fechar e abrir de novo sozinho.', actions: [] }; break;
      case 'ready': out.line = s.message || 'Instalador aberto.'; out.toast = { text: 'Atualização baixada', sub: s.message || '', actions: ['close'] }; break;
      case 'error': out.line = s.message || 'Não foi possível atualizar.'; if (s.message && !/verificar/i.test(s.message)) out.toast = { text: 'A atualização não foi instalada', sub: s.message, actions: ['close'] }; break;
      case 'disabled': out.line = 'Atualizações automáticas não estão configuradas nesta instalação.'; break;
      default: out.line = s.enabled ? 'Nenhuma verificação ainda.' : 'Atualizações automáticas não estão configuradas nesta instalação.';
    }
    return out;
  }

  function css() {
    return '.upd-toast{position:fixed;right:14px;bottom:14px;z-index:2147482000;width:min(360px,calc(100vw - 28px));padding:14px 16px;border:1px solid #344050;border-radius:18px;background:#171E2B;color:#f5f2f5;box-shadow:0 20px 60px #000b;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}'
      + '.upd-toast[hidden]{display:none}.upd-toast b{display:block;font-size:14px}.upd-toast small{display:block;margin-top:2px;color:#a9b2c2}.upd-toast .upd-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}'
      + '.upd-toast button,.upd-card button{font:inherit;font-weight:700;cursor:pointer;border-radius:999px;padding:7px 14px;border:1px solid #344050;background:#202838;color:#f2f4f8}'
      + '.upd-toast button.main,.upd-card button.main{background:#FFAC8F;border-color:transparent;color:#2b1519}.upd-toast button:focus-visible,.upd-card button:focus-visible{outline:2px solid #FFAC8F;outline-offset:2px}'
      + '.upd-bar{height:6px;border-radius:6px;background:#0b101c;margin-top:8px;overflow:hidden}.upd-bar i{display:block;height:100%;background:#FFAC8F;width:0}'
      + '.upd-card button[disabled]{opacity:.5;cursor:default}.upd-card label{display:flex;flex-direction:row;gap:8px;align-items:center;margin:8px 0;color:#d6dbe6;font-size:13px}.upd-card label input{width:auto;flex:none;margin:0}.upd-card #upd-line{margin:0}.upd-card .upd-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}';
  }

  function install(win) {
    const bridge = win.duoDesktop?.updates;
    if (!bridge) return;
    const doc = win.document;
    const style = doc.createElement('style'); style.textContent = css(); doc.head.append(style);
    const el = (tag, text, attrs = {}) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    let state = null, dismissed = null, hideTimer = null;

    const toast = el('div', undefined, { class: 'upd-toast', role: 'status', 'aria-live': 'polite' });
    toast.hidden = true; doc.body.append(toast);

    const card = doc.querySelector('#profile-updates');
    const line = card?.querySelector('#upd-line'), auto = card?.querySelector('#upd-auto'), checkBtn = card?.querySelector('#upd-check'), installBtn = card?.querySelector('#upd-install');
    if (card) card.hidden = false;

    const act = {
      install: () => bridge.install(),
      later: () => { dismissed = state?.version || null; render(); },
      close: () => { toast.hidden = true; dismissed = state?.version || dismissed; }
    };
    const LABEL = { install: 'Atualizar agora', later: 'Depois', close: 'Fechar' };

    function render() {
      const d = describe(state, dismissed);
      if (line) line.textContent = d.line;
      if (auto && state) { auto.checked = state.auto !== false; auto.disabled = !state.enabled; }
      if (checkBtn) checkBtn.disabled = !d.canCheck;
      if (installBtn) { installBtn.hidden = !d.canInstall; installBtn.textContent = 'Atualizar agora'; }
      toast.replaceChildren();
      if (!d.toast) { toast.hidden = true; return; }
      toast.append(el('b', d.toast.text));
      if (d.toast.sub) toast.append(el('small', d.toast.sub));
      if (state?.status === 'downloading') { const bar = el('div', undefined, { class: 'upd-bar' }); const i = el('i'); i.style.width = pct(state.progress) + '%'; bar.append(i); toast.append(bar); }
      if (d.toast.actions.length) {
        const row = el('div', undefined, { class: 'upd-actions' });
        d.toast.actions.forEach((name, i) => { const b = el('button', LABEL[name], { type: 'button', class: i === 0 ? 'main' : '' }); b.addEventListener('click', act[name]); row.append(b); });
        toast.append(row);
      }
      toast.hidden = false;
    }
    let failReported = false;
    function apply(s) {
      if (!s) return;
      state = s;
      // A atualização automática falhou na instalação (não na verificação): só a categoria vai para as estatísticas, se permitidas
      if (s.status === 'error' && /^Falha ao atualizar/.test(s.message || '')) { if (!failReported) { failReported = true; try { win.DuoTelemetry?.shared?.()?.event('app_error', 'update_fail'); } catch { /* sem estatísticas */ } try { win.DuoFeedback?.problem?.('update_fail'); } catch { /* sem feedback */ } } }
      else if (s.status !== 'error') failReported = false;
      win.clearTimeout(hideTimer);
      if (s.status === 'current') hideTimer = win.setTimeout(() => { if (state?.status === 'current') { state = { ...state, status: 'idle' }; render(); } }, 8000);
      render();
    }

    checkBtn?.addEventListener('click', () => { bridge.check().then(apply).catch(() => {}); });
    installBtn?.addEventListener('click', () => { bridge.install().then(apply).catch(() => {}); });
    auto?.addEventListener('change', () => { bridge.setAuto(auto.checked).then(apply).catch(() => {}); });
    bridge.onState(apply);
    bridge.getState().then(apply).catch(() => {});
  }

  return { install, describe };
});
