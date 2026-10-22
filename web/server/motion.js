/* Nível de movimento da interface. A pessoa escolhe em Perfil → Aparência → Movimento; "Automático" segue o sistema operacional
   (o "reduzir movimento" do Windows/macOS), mas "Completo" **vence** o sistema, para quem tem o movimento reduzido no computador e quer ver as animações.
   O resultado vai para <html data-motion="full|reduced|off"> e é lido por styles/motion.css e pelos componentes.
   Carrega no <head>, antes da primeira pintura, para a tela nunca piscar no nível errado. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DuoMotion = api; if (typeof document !== 'undefined') api.install(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'duotela-motion';
  const CHOICES = ['auto', 'full', 'reduced', 'off'];
  const LABELS = { auto: 'Automático (segue o sistema)', full: 'Completo', reduced: 'Reduzido (sem movimento, só mudanças suaves)', off: 'Desligado' };

  /** O nível que vale agora, dada a escolha e o que o sistema pede. */
  function resolve(choice, systemReduced) {
    const c = CHOICES.includes(choice) ? choice : 'auto';
    return c === 'auto' ? (systemReduced ? 'reduced' : 'full') : c;
  }
  /** Explica em uma frase por que o nível atual é o que é. */
  function explain(choice, systemReduced) {
    const level = resolve(choice, systemReduced);
    if (choice === 'auto' || !CHOICES.includes(choice)) return systemReduced ? 'Agora: Reduzido, porque o seu sistema pede menos movimento. Escolha Completo para ver as animações mesmo assim.' : 'Agora: Completo, porque o seu sistema não pede menos movimento.';
    return 'Agora: ' + { full: 'Completo', reduced: 'Reduzido', off: 'Desligado' }[level] + ', por escolha sua.';
  }

  function install(win) {
    const doc = win.document;
    const mq = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const store = () => { try { return win.localStorage; } catch { return null; } };
    const read = () => { try { const v = store()?.getItem(KEY); return CHOICES.includes(v) ? v : 'auto'; } catch { return 'auto'; } };
    let choice = read(), level = 'full';
    const listeners = new Set();
    function apply() {
      level = resolve(choice, !!mq?.matches);
      doc.documentElement.setAttribute('data-motion', level);
      for (const fn of listeners) { try { fn(level, choice); } catch { /* um ouvinte com defeito não derruba os outros */ } }
      paintNote();
    }
    const select = () => doc.getElementById('motion-select');
    function paintNote() {
      const s = select(); if (s && s.value !== choice) s.value = choice;
      const n = doc.getElementById('motion-note'); if (n) n.textContent = explain(choice, !!mq?.matches);
    }
    function bind() {
      const s = select(); if (!s || s.dataset.bound) { paintNote(); return; }
      s.dataset.bound = '1'; s.value = choice; s.addEventListener('change', () => api.set(s.value)); paintNote();
    }
    if (mq?.addEventListener) mq.addEventListener('change', apply);
    const api = win.DuoMotion || (win.DuoMotion = {});
    api.choice = () => choice;
    api.level = () => level;
    /** true quando o movimento deve ser evitado (reduzido ou desligado). */
    api.reduced = () => level !== 'full';
    api.set = (c) => {
      if (!CHOICES.includes(c)) return false;
      choice = c;
      try { store()?.setItem(KEY, c); } catch { /* sem armazenamento: vale só nesta abertura */ }
      apply(); return true;
    };
    api.onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
    apply();
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind); else bind();
    return api;
  }

  return { install, resolve, explain, CHOICES, LABELS, KEY };
});
