/* "Novidades": depois de atualizar, uma janela curta mostra o que mudou desde a última versão que a pessoa viu. Aparece uma vez por versão,
   nunca para quem acabou de instalar (que já passa pelas boas-vindas) e pode ser reaberta em Perfil → O que há de novo.
   Para uma versão nova entrar aqui, acrescente uma linha em NEWS (versão → itens) e aumente o número no package/tag como de costume. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DuoWhatsNew = api; if (typeof document !== 'undefined') api.install(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEEN_KEY = 'duotela-news-seen';
  const BASELINE = '0.3.1';          // quem nunca viu a janela é tratado como estando nesta versão
  // [ícone, título, texto curto]. Do mais novo para o mais antigo dentro de cada versão.
  const NEWS = {
    '0.4.3': [
      ['\u{1F39E}️', 'Netflix: ponto do filme sincronizado', 'A sala agora move o filme pelo próprio player da Netflix, o que evita o erro ao alinhar todo mundo no mesmo ponto.'],
      ['\u{1F504}', 'Atualização obrigatória quando necessário', 'Se uma versão deixar de conectar, o app avisa e pede para atualizar antes de criar ou entrar em salas. O resto continua funcionando.'],
    ],
    '0.4.2': [
      ['\u{1F527}', 'Conexão da sala corrigida', 'A 0.4.1 podia falhar ao conectar até na mesma rede. Agora o convite leva os caminhos certos e o retransmissor funciona de verdade.'],
    ],
    '0.4.1': [
      ['\u{1F310}', 'Conexão entre redes diferentes', 'Quando a conexão direta não abre (Mac e Windows em redes diferentes, 4g, redes fechadas), o app passa a usar um retransmissor seguro e a sala conecta.'],
      ['\u{1F6AA}', 'Sair e fechar a sala sempre funcionam', 'Corrigido o travamento ao fechar a sala: agora ela fecha e o painel some, mesmo sem internet.'],
    ],
    '0.4.0': [
      ['\u{1F39E}️', 'Movimento sob o seu controle', 'Em Perfil → Aparência você escolhe Completo, Reduzido ou Desligado. As reações voltam a aparecer mesmo com o "reduzir movimento" do sistema ligado.'],
      ['\u{1F524}', 'Base visual nova', 'A fonte Inter agora vem junto com o app e há um conjunto de cores e medidas único, preparando a nova tela inicial.'],
    ],
    '0.3.3': [
      ['\u{1F3E0}', 'Sala só sua', 'Crie a sala e use tudo sozinho; o convidado se junta quando quiser, com a sua aprovação.'],
      ['\u{1F3AC}', 'Sugestões por clima e plataforma', 'No Início, escolha o clima, a plataforma ou toque em Me surpreenda. A lista é uma só e mostra por que combina.'],
      ['▶️', 'Trailer e "Levar para a sala"', 'Nos títulos você vê o trailer e indica o filme para a votação da sala com um toque.'],
      ['\u{1F4DA}', 'Catálogo sempre novo', 'A lista de títulos agora se atualiza sozinha, com duração e onde assistir no Brasil.'],
    ],
    '0.3.2': [
      ['\u{1F517}', 'Convite com um toque', 'Convidar copia uma mensagem com um link: quem tocar nele abre o app e entra na sala sozinho.'],
      ['☕', 'Intervalo', 'Pausa para todos no mesmo ponto, com contagem regressiva; no fim, 3-2-1 e todos voltam juntos.'],
      ['\u{1F39E}️', 'Fila de vídeos do YouTube', 'Adicione vários links; quando um acaba, o próximo toca sozinho.'],
      ['\u{1F4AC}', 'Chat da sala', 'Um botão no canto, sem cobrir o vídeo, para mandar mensagens curtas.'],
      ['⏱️', 'Aviso quando alguém fica para trás', '"Fulano ficou 8 s atrás" com um botão para alinhar todos.'],
      ['\u{1F4A1}', 'Sugestão ou problema', 'Fale direto com o criador pelo botão da lateral; quando algo dá errado, o app oferece reportar em um clique.'],
    ],
  };

  /** -1, 0 ou 1. Versões como "0.3.2"; o que não for número vale 0. */
  function compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
    return 0;
  }
  const validVersion = (v) => typeof v === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v);

  /** O que mudou depois de `lastSeen` até `current` (inclusive), da versão mais nova para a mais antiga: [{ version, items }]. */
  function entriesSince(lastSeen, current, news = NEWS) {
    if (!validVersion(current)) return [];
    const from = validVersion(lastSeen) ? lastSeen : BASELINE;
    return Object.keys(news).filter((v) => compareVersions(v, from) > 0 && compareVersions(v, current) <= 0)
      .sort((a, b) => compareVersions(b, a)).map((version) => ({ version, items: news[version] }));
  }
  /** Para reabrir em Perfil: as novidades da versão atual (ou da mais recente que tenha). */
  function latestEntries(current, news = NEWS, count = 2) {
    if (!validVersion(current)) return [];
    return Object.keys(news).filter((v) => compareVersions(v, current) <= 0).sort((a, b) => compareVersions(b, a)).slice(0, count).map((version) => ({ version, items: news[version] }));
  }

  /** Decide o que fazer ao abrir o app: 'show' (com a lista), ou 'skip'. Sempre devolve a versão a guardar como vista. */
  function decide({ current, lastSeen, welcomeSeen, news = NEWS }) {
    if (!validVersion(current)) return { action: 'skip', remember: null };      // versão de desenvolvimento: nada a mostrar nem guardar
    if (!welcomeSeen) return { action: 'skip', remember: current };             // instalação nova: vai passar pelas boas-vindas
    const groups = entriesSince(lastSeen, current, news);
    return { action: groups.length && lastSeen !== current ? 'show' : 'skip', remember: current, groups };
  }

  function install(win) {
    const doc = win.document;
    const store = () => { try { return win.localStorage; } catch { return null; } };
    const get = (k) => { try { return store()?.getItem(k) ?? null; } catch { return null; } };
    const set = (k, v) => { try { store()?.setItem(k, v); } catch { /* sem armazenamento: a janela pode voltar na próxima abertura */ } };
    const style = doc.createElement('style');
    style.textContent = '.wn-group{margin:16px 0 0}.wn-group h3{margin:0 0 8px;font-size:13px;color:#FFAC8F;letter-spacing:.04em;text-transform:uppercase}'
      + '.wn-item{display:flex;gap:12px;align-items:flex-start;margin:0 0 10px}.wn-icon{flex:0 0 28px;font-size:20px;line-height:1.2;text-align:center}.wn-item b{display:block;font-size:14px}.wn-item span{color:#cfd6e2}';
    doc.head.append(style);
    let dialog = null;
    const el = (tag, text, attrs = {}) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const close = () => { const d = dialog; dialog = null; if (d) { try { d.close(); } catch { /* já fechado */ } d.remove(); } };

    function show(groups, version) {
      close();
      dialog = el('dialog', undefined, { class: 'duo-dialog', 'aria-labelledby': 'wn-title' });
      dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; });
      dialog.append(el('h2', 'O que há de novo', { id: 'wn-title' }), el('p', version && version !== 'dev' ? 'Você está na versão ' + version + '.' : 'Resumo das últimas novidades.', { class: 'lead' }));
      for (const g of groups) {
        const sec = el('section', undefined, { class: 'wn-group' });
        sec.append(el('h3', 'Versão ' + g.version));
        for (const [icon, title, text] of g.items) {
          const row = el('div', undefined, { class: 'wn-item' });
          const body = el('div'); body.append(el('b', title), el('span', text));
          row.append(el('span', icon, { class: 'wn-icon', 'aria-hidden': 'true' }), body);
          sec.append(row);
        }
        dialog.append(sec);
      }
      const actions = el('div', undefined, { class: 'duo-actions' });
      const ok = el('button', 'Entendi', { type: 'button', class: 'duo-btn main' }); ok.addEventListener('click', close);
      actions.append(ok); dialog.append(actions);
      doc.body.append(dialog); dialog.showModal(); dialog.scrollTop = 0; ok.focus({ preventScroll: true });
    }

    const tel = () => win.DuoTelemetry?.shared?.() || null;
    async function currentVersion() { const t = tel(); if (!t) return null; try { await t.loadConfig(); } catch { /* sem configuração */ } return t.config?.version || null; }

    doc.addEventListener('click', async (e) => {
      if (!e.target.closest?.('[data-duo-open=news]')) return;
      const v = await currentVersion();
      const groups = latestEntries(v);
      show(groups.length ? groups : latestEntries('99.0.0', NEWS, 1), v);
    });

    // Ao abrir: mostra uma vez por versão, quando já passou das boas-vindas e nenhuma outra janela está aberta
    async function onOpen() {
      const version = await currentVersion();
      const flag = win.DuoFirstRun?.FLAG_KEY;
      const d = decide({ current: version, lastSeen: get(SEEN_KEY), welcomeSeen: !!flag && get(flag) === '1' });
      if (d.remember) set(SEEN_KEY, d.remember);
      if (d.action !== 'show') return;
      const tryShow = (left) => { if (doc.querySelector('dialog[open]') && left > 0) { win.setTimeout(() => tryShow(left - 1), 4000); return; } if (!doc.querySelector('dialog[open]')) show(d.groups, version); };
      win.setTimeout(() => tryShow(3), 1500);
    }
    void onOpen();
    win.DuoWhatsNew.show = () => show(latestEntries('99.0.0', NEWS, 2), null);
  }

  return { install, decide, entriesSince, latestEntries, compareVersions, NEWS, SEEN_KEY, BASELINE };
});
