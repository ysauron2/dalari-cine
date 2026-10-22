/* Boas-vindas na primeira abertura e política de privacidade. O texto da política é a única fonte; PRIVACIDADE.md na raiz
   do repositório é a mesma redação para leitura no GitHub. Se este texto mudar de forma relevante (por exemplo, ao
   incluir estatísticas de uso), aumente WELCOME_VERSION para a tela voltar a aparecer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DuoFirstRun = api; if (typeof document !== 'undefined') api.install(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WELCOME_VERSION = 4;                  // 4: etapas do pareamento e qualidade da chamada em faixas (consentimento v2)
  const FLAG_KEY = 'duotela-welcome-v' + WELCOME_VERSION;
  const POLICY_DATE = '22/10/2026';

  const STATS_BLOCKS = [
    ['O que é enviado', 'A cada 2 minutos, enquanto o app está aberto: um número aleatório da instalação, a versão do app, o sistema (Windows, Mac ou Linux), se você está em sala ou em chamada, e contadores (salas criadas, chamadas iniciadas, duração em faixas como "5 a 30 minutos", o tipo de conexão, falhas de voz, as etapas do pareamento por código curto e se ele falhou, a qualidade da chamada em faixas (boa, média ou ruim), o tempo para a voz conectar e erros do app em categorias fixas, como "microfone bloqueado" ou "vídeo não abriu", sem mensagem nem detalhes). Também é registrada a hora em que o app está aberto, para saber os horários de pico.'],
    ['O que nunca é enviado', 'Nome, o que você assiste, conversas, o código ou os participantes das salas, e o seu endereço IP não é guardado.'],
    ['Para quê', 'Para o criador, que mantém o app sozinho, saber quantas pessoas usam, quais recursos funcionam e onde há falhas (como voz que não conecta ou pareamento que não completa), e assim corrigir e melhorar o app nas redes e computadores de verdade. Você decide agora e pode mudar quando quiser em Perfil → Estatísticas anônimas.'],
  ];

  const welcomeBlocks = (statsAvailable) => [
    ['O que é o Dalari Cine', 'Duas telas, uma sessão: cada pessoa assiste no próprio serviço (YouTube, Netflix) e o Dalari Cine sincroniza o play, a pausa e a posição, com conversa por voz. Ele não transmite nem grava o vídeo.'],
    ['De onde vem o nome', 'Dalari junta Daniel e Larissa. O Daniel criou o app para assistir filmes com ela mesmo à distância. Cine é a sessão de cinema que vocês montam, cada um na sua tela.'],
    ['Seus dados ficam com você', 'O Dalari Cine não tem cadastro nem login próprios e não guarda nenhum dado de cadastro. O que você configura (nome de exibição, preferências, histórico e progresso) fica salvo apenas neste computador. A Netflix é acessada na janela da própria Netflix: o Dalari Cine não lê nem guarda sua senha, e a sessão fica somente no perfil do aplicativo neste computador.'],
    ['O que sai do seu computador', 'Para falar com outra pessoa, os aparelhos se conectam direto, de forma criptografada. O código curto usa um serviço de encontro gratuito de terceiros (ntfy.sh) que vê apenas texto cifrado e os endereços de rede de quem conecta. Para achar o caminho da conexão, é consultado um servidor STUN público do Google.'],
    statsAvailable
      ? ['Estatísticas anônimas (opcionais)', 'O criador do app recebe estatísticas anônimas de uso e de falhas (por exemplo, se a voz não conectou) para melhorar o Dalari Cine. Nada é enviado sem a sua permissão. Você escolhe no fim desta tela e pode mudar depois em Perfil.']
      : ['Estatísticas de uso', 'Esta versão não envia estatísticas de uso. Quando houver estatísticas anônimas (para o criador saber quantas pessoas usam o app), elas serão opcionais: o app pedirá a sua permissão antes de enviar qualquer coisa.'],
  ];
  const WELCOME = welcomeBlocks(false);

  // Sobre e créditos. Os endereços abaixo são os únicos que o app abre fora dele (lista igual em app/src/external-links.cjs).
  const LINKS = { author: 'https://github.com/ysauron2', repo: 'https://github.com/ysauron2/dalari-cine' };
  const ABOUT = [
    ['Feito para assistir junto', 'O Dalari Cine foi criado por Daniel Didini (Kaizen) para que quem está longe possa ver o mesmo filme ao mesmo tempo, conversando por voz. É gratuito e sem anúncios.'],
    ['Em homenagem a Larissa B.', 'Larissa foi quem o incentivou a tirar a ideia do papel. O nome Dalari junta Daniel e Larissa, e este app existe por causa desse incentivo.'],
    ['Código aberto', 'O código é livre, sob a licença MIT, e está no GitHub. Sugestões e problemas podem ser enviados por lá, em "issues".'],
    ['Feito com ajuda de', 'Electron for Content Security (Castlabs) e Chromium, Widevine (Google), TMDB (catálogo de títulos e capas), ntfy.sh (código curto), Cloudflare (estatísticas opcionais) e o servidor STUN do Google. Cada um tem a sua própria licença; veja THIRD-PARTY-NOTICES.md no repositório.'],
    ['TMDB', 'This product uses the TMDB API but is not endorsed or certified by TMDB.'],
    ['Aviso', 'O Dalari Cine não é afiliado, patrocinado nem aprovado pela Netflix, pelo YouTube ou pelo TMDB. Netflix e YouTube são marcas dos seus donos. O app não captura, grava nem retransmite vídeo: cada pessoa assiste no próprio serviço, com a própria conta.'],
  ];

  const POLICY = [
    ['Quem somos', 'O Dalari Cine é um aplicativo gratuito de assistir junto, mantido por uma pessoa física. Dúvidas ou pedidos sobre privacidade: abra uma "issue" no repositório do projeto no GitHub.'],
    ['Dados guardados no seu computador', 'Nome de exibição, preferências, histórico, progresso e a sessão da Netflix ficam apenas no seu computador (no perfil do aplicativo e no armazenamento do navegador). Nada disso é enviado a um servidor do Dalari Cine, porque não existe servidor do Dalari Cine com conta de usuário. Uma cópia de segurança do nome e das preferências (sem a sessão da Netflix) fica no mesmo perfil, num arquivo chamado settings-backup.json, para que nada se perca ao atualizar ou reinstalar o aplicativo.'],
    ['Dados que saem do seu computador', '1) Conexão com a outra pessoa: um canal direto criptografado (WebRTC). Nele passam o estado da sala (votos, reprodução) e, pela voz, o áudio da conversa, que não passa por nenhum servidor nosso. 2) Código curto: mensagens cifradas de conexão enviadas ao serviço ntfy.sh, que vê o texto cifrado, o tamanho e o endereço de rede de quem conecta, mas não o conteúdo. 3) Descoberta de rota: consulta a um servidor STUN do Google, que vê o endereço de rede público do seu aparelho. 4) Catálogo de títulos e capas: consulta ao TMDB. 5) Vídeos do YouTube e a Netflix: carregados diretamente dos serviços deles, sob os termos e a política de cada um.'],
    ['Dados que não coletamos', 'Não coletamos nome real, e-mail, telefone, senhas, cartões, conteúdo de conversas, gravações de voz, o que você assiste nem a sua localização. Não há anúncios nem rastreamento.'],
    ['Estatísticas de uso (opcionais)', 'O objetivo é o criador receber informações para melhorar o app: quantas pessoas usam, quais recursos funcionam e onde acontecem falhas. Versões que têm o serviço de estatísticas ativado perguntam antes e não enviam nada sem a sua permissão; versões sem o serviço não enviam estatísticas. Se você aceitar, a cada 2 minutos com o app aberto é enviado a um serviço do criador, hospedado na Cloudflare: um número aleatório da instalação (criado só quando você aceita e apagado quando você recusa), a versão, o sistema, se você está em sala ou em chamada e contadores agregados (salas criadas, chamadas iniciadas, duração em faixas, tipo de conexão, falhas de voz, etapas do pareamento por código curto, qualidade da chamada em faixas, tempo para conectar e erros do app em categorias fixas, como microfone bloqueado, vídeo que não abriu, sala que caiu ou atualização que falhou; nunca o texto do erro, caminhos de arquivos ou dados pessoais). O serviço também guarda, por hora, quais instalações estiveram ativas (para o mapa de horários de pico) e o dia da primeira vez e dos retornos (para medir se as pessoas voltam). Não são enviados nome, o que você assiste, conteúdo de conversa, códigos ou participantes de salas, e o serviço não guarda o seu endereço IP (a Cloudflare, como provedora do serviço, vê o IP na própria conexão). Você pode ver o que é enviado e desligar a qualquer momento em Perfil → Estatísticas anônimas.'],
    ['Atualizações do aplicativo', 'Se você deixar ligado em Perfil → Atualizações (é o padrão), o app consulta o GitHub (github.com/…/releases) 20 segundos depois de abrir e a cada 6 horas para saber se há versão nova. O GitHub vê o endereço de rede do seu aparelho nessa consulta, como em qualquer download; nada do Dalari Cine é enviado além do pedido do arquivo. Uma versão nova só é instalada quando você clica em Atualizar agora, e o app confere uma assinatura digital antes de abrir o instalador. Você pode desligar a verificação automática em Perfil.'],
    ['Como apagar seus dados', 'Feche o Dalari Cine e apague a pasta "Dalari Cine" em %APPDATA% (Windows) ou em ~/Library/Application Support (macOS). Versões de teste antigas usavam a pasta "DuoTela Teste"; o app a renomeia sozinho na primeira abertura. Isso remove nome, preferências, histórico e a sessão da Netflix. Desinstalar o aplicativo não apaga essa pasta por si só.'],
    ['Atualizações desta política', 'Versão 4, de ' + POLICY_DATE + '. Mudanças relevantes serão mostradas no aplicativo, e quem aceitou uma versão anterior das estatísticas será perguntado de novo.'],
  ];

  function storage(win) { try { return win.localStorage; } catch { return null; } }
  const hasSeen = (win) => { const s = storage(win); try { return s?.getItem(FLAG_KEY) === '1'; } catch { return false; } };
  const markSeen = (win) => { try { storage(win)?.setItem(FLAG_KEY, '1'); } catch { /* sem armazenamento: a tela volta na próxima abertura */ } };

  function css() {
    return '.duo-dialog{width:min(640px,calc(100vw - 28px));max-height:calc(100vh - 40px);overflow:auto;padding:26px;border:1px solid #344050;border-radius:24px;background:#171E2B;color:#f5f2f5;box-shadow:0 30px 80px #000c;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}'
      + '.duo-dialog::backdrop{background:#05070cd9;backdrop-filter:blur(5px)}.duo-dialog h2{margin:0 0 4px;font-size:26px;letter-spacing:-.03em}.duo-dialog .lead{margin:0 0 14px;color:#a9b2c2}'
      + '.duo-dialog section{margin:14px 0}.duo-dialog h3{margin:0 0 3px;font-size:14px;color:#FFAC8F}.duo-dialog p{margin:0;color:#d6dbe6}'
      + '.duo-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.duo-btn{font:inherit;font-weight:700;cursor:pointer;border-radius:999px;padding:10px 18px;border:1px solid #344050;background:#202838;color:#f2f4f8}'
      + '.duo-btn.main{background:#FFAC8F;border-color:transparent;color:#2b1519}.duo-btn:hover{filter:brightness(1.08)}.duo-btn:focus-visible{outline:2px solid #FFAC8F;outline-offset:2px}'
      + '.duo-pre{font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;background:#0b101c;border:1px solid #344050;border-radius:12px;padding:10px 12px;color:#bff3d6!important}'
      + '.wl-hero{position:relative;height:150px;margin:-8px -8px 4px;display:grid;place-items:center;perspective:700px;overflow:hidden;border-radius:18px;background:radial-gradient(ellipse at 50% 120%,#ffac8f2e,transparent 70%)}'
      + '.wl-logo{position:relative;width:84px;height:84px;border-radius:22px;box-shadow:0 14px 40px #f58fb455;animation:wl-pop .9s cubic-bezier(.2,1.3,.3,1) both,wl-sway 7s ease-in-out .9s infinite}'
      + '.wl-ring{position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;border:2px solid #ffac8f66;opacity:0;animation:wl-ring 2.8s ease-out .9s infinite}.wl-ring.b{animation-delay:2.3s}'
      + '.wl-spark{position:absolute;left:var(--x);top:var(--y);width:var(--s);height:var(--s);color:#ffd9c8;opacity:0;animation:wl-twinkle var(--d) ease-in-out var(--l) infinite}'
      + '.duo-welcome section{opacity:0;transform:translateY(10px);animation:wl-in .6s ease-out forwards;animation-delay:calc(.5s + var(--i,0)*.12s)}.duo-welcome .duo-actions{opacity:0;animation:wl-in .6s ease-out 1.4s forwards}'
      + '@keyframes wl-pop{from{opacity:0;transform:scale(.4) rotateY(-120deg)}to{opacity:1;transform:scale(1) rotateY(0)}}@keyframes wl-sway{0%,100%{transform:rotateY(-14deg) rotateX(4deg)}50%{transform:rotateY(14deg) rotateX(-4deg)}}'
      + '@keyframes wl-ring{from{opacity:.7;transform:scale(.7)}to{opacity:0;transform:scale(2)}}@keyframes wl-in{to{opacity:1;transform:none}}@keyframes wl-twinkle{0%,100%{opacity:0;transform:scale(.6)}50%{opacity:.9;transform:scale(1)}}'
      + '@media (prefers-reduced-motion:reduce){.wl-hero *,.duo-welcome section,.duo-welcome .duo-actions{animation:none!important;opacity:1;transform:none}.wl-ring{display:none}}'
      + '.profile-adv{margin-top:18px}.profile-adv h3{margin:0 0 6px}.profile-adv .duo-btn{margin:0 8px 8px 0;font-size:12px;padding:8px 14px}';
  }

  function install(win) {
    const doc = win.document;
    const style = doc.createElement('style'); style.textContent = css(); doc.head.append(style);
    let dialog = null;
    const el = (tag, text, attrs = {}) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    // Fecha e remove na hora (sem esperar o evento 'close', que alguns ambientes atrasam); o Esc ainda passa pelo evento.
    function closeDialog() { const d = dialog; dialog = null; if (d) { try { d.close(); } catch { /* já fechado */ } d.remove(); } }
    function open(title, lead, blocks, actions) {
      dialog?.remove();
      dialog = el('dialog', undefined, { class: 'duo-dialog', 'aria-labelledby': 'duo-dialog-title' });
      dialog.append(el('h2', title, { id: 'duo-dialog-title' }));
      if (lead) dialog.append(el('p', lead, { class: 'lead' }));
      for (const [h, p, mono] of blocks) { const s = el('section'); s.append(el('h3', h), mono ? el('p', p, { class: 'duo-pre' }) : el('p', p)); dialog.append(s); }
      const row = el('div', undefined, { class: 'duo-actions' });
      for (const a of actions) { const b = el('button', a.label, { type: 'button', class: 'duo-btn' + (a.main ? ' main' : '') }); b.addEventListener('click', a.onClick); row.append(b); }
      dialog.append(row);
      doc.body.append(dialog);
      dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; });
      dialog.showModal(); dialog.scrollTop = 0;
      row.querySelector('.main')?.focus({ preventScroll: true });
    }
    function showPrivacy(back) {
      open('Política de privacidade', 'Curta e direta. Versão 4, ' + POLICY_DATE + '.', POLICY, [{ label: back ? 'Voltar' : 'Fechar', main: true, onClick: () => { closeDialog(); if (back) showWelcome(); } }]);
    }
    const tel = win.DuoTelemetry?.shared?.() || null;
    const choose = (value, then) => { tel?.setConsent(value); refreshStatsButton(); then?.(); };
    function refreshStatsButton() {
      const b = doc.querySelector('#duo-stats-btn');
      if (!b) return;
      b.hidden = !tel?.available;
      b.textContent = 'Estatísticas anônimas: ' + (tel?.consent === 'on' ? 'ligadas' : tel?.consent === 'off' ? 'desligadas' : 'não decidido');
    }
    // Depois das boas-vindas, na primeira vez, o assistente de áudio e conexão (dá para pular)
    function afterWelcome() {
      const A = win.DuoAudioCheck;
      if (A && !A.hasSeen(win)) win.setTimeout(() => A.open({ win, firstRun: true }), 350);
    }
    // Cabeçalho animado das boas-vindas: o logo entra girando em 3D, anéis de luz e estrelinhas, e os blocos de texto aparecem em sequência
    function decorateWelcome() {
      const d = dialog;
      if (!d) return;
      d.classList.add('duo-welcome');
      const hero = el('div', undefined, { class: 'wl-hero', 'aria-hidden': 'true' });
      hero.append(el('span', undefined, { class: 'wl-ring' }), el('span', undefined, { class: 'wl-ring b' }), el('img', undefined, { class: 'wl-logo', src: 'assets/duotela-icon.png', alt: '' }));
      const stars = [[12, 22], [86, 18], [24, 70], [76, 72], [50, 10], [92, 52]];
      stars.forEach(([x, y], i) => {
        const sp = win.DuoIcons?.node(doc, 'sparkle', 'wl-spark');
        if (!sp) return;
        sp.style.setProperty('--x', x + '%'); sp.style.setProperty('--y', y + '%'); sp.style.setProperty('--s', (12 + (i % 3) * 5) + 'px');
        sp.style.setProperty('--d', (3 + (i % 3)) + 's'); sp.style.setProperty('--l', (i * 0.5) + 's');
        hero.append(sp);
      });
      d.insertBefore(hero, d.firstChild);
      [...d.querySelectorAll('section')].forEach((sec, i) => sec.style.setProperty('--i', String(i)));
    }
    function showWelcome() {
      const stats = !!tel?.available;
      open('Bem-vindo ao Dalari Cine', 'Antes de começar, o essencial sobre os seus dados.', welcomeBlocks(stats).concat(stats ? STATS_BLOCKS : []), stats ? [
        { label: 'Aceitar estatísticas e continuar', main: true, onClick: () => { choose('on'); markSeen(win); closeDialog(); afterWelcome(); } },
        { label: 'Continuar sem enviar', onClick: () => { choose('off'); markSeen(win); closeDialog(); afterWelcome(); } },
        { label: 'Ler a política de privacidade', onClick: () => showPrivacy(true) },
      ] : [
        { label: 'Entendi', main: true, onClick: () => { markSeen(win); closeDialog(); afterWelcome(); } },
        { label: 'Ler a política de privacidade', onClick: () => showPrivacy(true) },
      ]);
      decorateWelcome();
      dialog.addEventListener('cancel', () => { /* Esc fecha sem marcar como visto: volta na próxima abertura */ });
    }
    // Perfil → Estatísticas anônimas: decidir (se ainda não), ver exatamente o que é enviado e ligar/desligar
    function showStats() {
      if (!tel?.available) { open('Estatísticas anônimas', 'Esta versão não tem o serviço de estatísticas ativado, então nada é enviado.', [], [{ label: 'Fechar', main: true, onClick: () => closeDialog() }]); return; }
      const d = tel.describe();
      const on = d.consent === 'on';
      const blocks = d.consent === null ? STATS_BLOCKS.slice() : [
        ['Estado', on ? 'Ligadas: o app envia a cada ' + d.everyMinutes + ' minutos enquanto está aberto, para ' + d.host + '.' : 'Desligadas: nada é enviado e não existe identificador neste computador.'],
      ];
      blocks.push(['Exemplo exato do que é enviado', JSON.stringify(d.example, null, 2), true]);
      if (on) blocks.push(['Último envio', d.last ? JSON.stringify(d.last, null, 2) : 'ainda nenhum', true]);
      if (on && d.lastError) blocks.push(['Último erro de envio', d.lastError]);
      const actions = d.consent === null
        ? [{ label: 'Aceitar', main: true, onClick: () => choose('on', () => closeDialog()) }, { label: 'Agora não', onClick: () => choose('off', () => closeDialog()) }]
        : [{ label: on ? 'Desligar estatísticas' : 'Ligar estatísticas', main: true, onClick: () => choose(on ? 'off' : 'on', () => closeDialog()) }, { label: 'Fechar', onClick: () => closeDialog() }];
      open('Estatísticas anônimas', 'Opcionais, só com a sua permissão.', blocks, actions);
    }
    function openLink(url) {
      if (win.duoDesktop?.openExternal) win.duoDesktop.openExternal(url);      // no app: o processo principal só abre os endereços da lista
      else win.open(url, '_blank', 'noopener,noreferrer');
    }
    function showAbout() {
      const v = tel?.config?.version;
      open('Sobre o Dalari Cine', v && v !== 'dev' ? 'Versão ' + v : 'Créditos e agradecimentos', ABOUT, [
        // A homenagem animada em 3D (tribute.js) abre com um clique; nunca aparece sozinha.
        { label: '♥ Ver a homenagem', main: true, onClick: () => { closeDialog(); win.DuoTribute?.show({ force: true, win }); } },
        { label: 'Perfil do Kaizen no GitHub', onClick: () => openLink(LINKS.author) },
        { label: 'Código no GitHub', onClick: () => openLink(LINKS.repo) },
        { label: 'Fechar', onClick: () => closeDialog() },
      ]);
    }
    // Atalhos da aba Perfil
    doc.addEventListener('click', (e) => {
      const t = e.target.closest?.('[data-duo-open]');
      if (!t) return;
      if (t.dataset.duoOpen === 'privacy') showPrivacy(false);
      if (t.dataset.duoOpen === 'welcome') showWelcome();
      if (t.dataset.duoOpen === 'stats') showStats();
      if (t.dataset.duoOpen === 'about') showAbout();
      if (t.dataset.duoOpen === 'audiocheck') win.DuoAudioCheck?.open({ win });
    });
    win.DuoFirstRun.showWelcome = showWelcome; win.DuoFirstRun.showPrivacy = () => showPrivacy(false); win.DuoFirstRun.showAbout = showAbout;
    // Carrega o endereço do serviço de estatísticas; se a pessoa já permitiu, retoma os avisos.
    const ready = tel ? tel.loadConfig().then(() => { if (tel.consent === 'on') tel.start(); refreshStatsButton(); }) : Promise.resolve();
    ready.then(() => {
      if (!hasSeen(win)) win.setTimeout(showWelcome, 500);
      else if (tel?.available && tel.consent === null) win.setTimeout(showStats, 500);   // quem já viu as boas-vindas e ainda não decidiu
    });
  }

  return { install, WELCOME, POLICY, ABOUT, LINKS, WELCOME_VERSION, FLAG_KEY };
});
