# Dalari Cine — prévia local

Dalari Cine significa **duas telas, uma sessão**. O símbolo nasceu de Daniel e Larissa, mas o aplicativo será preparado para outras duplas no GitHub. Consulte `../DUOTELA-IDENTIDADE.md` e `../DUOTELA-ROADMAP.md` para a identidade e a ordem dos próximos recursos.

## Abrir a prévia

Abra `index.html` no navegador. Os pôsteres ficam na pasta `assets`, ao lado do arquivo. O visual também está em um [arquivo inicial do Figma](https://www.figma.com/design/VTLV4Ax2jrYIUiBdN1lymK).

Para testar a **sala conectada na mesma máquina**, com Node 24 instalado, abra um terminal nesta pasta e execute `node server/index.js`. Depois abra `http://127.0.0.1:8787/` em até **quatro abas separadas**. Em cada aba, abra **Perfil** e salve um nome. Na primeira, vá a **Nossa sala → Criar sala**; o Host gera um convite de uso único para cada convidado e aprova cada entrada uma vez. Os votos e o match consideram todas as pessoas aprovadas na rodada. No YouTube, qualquer participante pode abrir um vídeo por link ou busca sem nova aprovação; se houve match de um título, qualquer um pode escolher o vídeo exato. Play e pausa são enviados à sala. Se o navegador bloquear a reprodução automática, a pessoa clica em **Reproduzir aqui** no próprio player. A credencial fica apenas na memória da aba; recarregar a página perde o acesso à sala. Feche a sala pelo Host ao terminar.

Essa prova usa HTTP apenas em `127.0.0.1`: não coloque o endereço diretamente na internet. A interface e o serviço ainda não foram testados em duas máquinas/redes ou no Safari. Veja `server/README.md`.

### Ativar o catálogo TMDB (opcional)

A prévia já inclui um catálogo local de 50 títulos consultados no TMDB, com pôsteres e serviços informados para o Brasil no momento da consulta. Essas informações podem mudar. Para atualizar os dados em tempo real, o serviço aceita um **API Read Access Token** do TMDB na variável `TMDB_READ_ACCESS_TOKEN`. A chave fica no processo Node, não é enviada ao navegador nem incluída nos arquivos do projeto. No PowerShell, nesta pasta:

```powershell
$tmdbSecure = Read-Host 'TMDB API Read Access Token' -AsSecureString
$env:TMDB_READ_ACCESS_TOKEN = [System.Net.NetworkCredential]::new('', $tmdbSecure).Password
Remove-Variable tmdbSecure
node server/index.js
```

Ao iniciar com a chave, o serviço consulta filmes, séries e animações japonesas, normaliza os dados em português e mostra os títulos reais no dashboard e na sala. Cada registro usa `tmdb:movie:ID` ou `tmdb:tv:ID`; assim, a mesma série encontrada em duas listas não vira duplicata. As sugestões usam gêneros, avaliações e histórico salvos por vocês. Sem chave, a prévia usa o catálogo local de 50 títulos consultados anteriormente no TMDB; se esse arquivo estiver indisponível, usa o catálogo fictício. A sala filtra títulos pela indicação de disponibilidade brasileira do TMDB para Netflix, Prime Video, Crunchyroll ou YouTube grátis. Essa indicação não garante que o vídeo exato possa abrir no Dalari Cine.

### Buscar vídeos do YouTube dentro da sala (opcional)

A busca por palavras exige uma chave da YouTube Data API. Se você a tiver, defina `YOUTUBE_DATA_API_KEY` no processo Node antes de iniciar o servidor. Ela fica fora da interface e dos arquivos. Sem essa chave, qualquer participante pode colar um link HTTPS do vídeo na sala. O player incorporado não faz login na conta YouTube Premium; alguns vídeos podem bloquear a incorporação. Não publique chaves no GitHub nem as cole no chat.

O uso não comercial da API exige atribuição ao TMDB; a aba Perfil mostra o logo e o aviso oficial quando o catálogo está ativo. A chave deve ser obtida pelo próprio usuário nas configurações da conta TMDB; não a publique no GitHub nem a cole no chat. A consulta real foi testada localmente: 50 títulos carregaram na porta 8789, com pôsteres visíveis. Isso não valida acesso pela internet de outra máquina nem reprodução dos streamings.

## O que já funciona na prévia

- Dashboard com navegação entre Início, Descobrir, Nossa lista, Histórico, Sala e Perfil.
- Perfil com nome de exibição salvo neste navegador e sincronizado na sala conectada. O nome aparece nos participantes, votos e detalhes; é apenas uma identificação visual, não prova de identidade.
- Busca e categorias para nove títulos fictícios de demonstração ou para o catálogo TMDB quando configurado.
- Na sala conectada, plataforma escolhida pelo Host e sincronizada, busca de títulos com capa, e busca opcional de vídeos do YouTube quando a Data API está configurada no servidor.
- Player oficial do YouTube por link direto para ambos, ou após um match de título, com ações de play e pausa compartilhadas. Reprodução e pausa passaram em duas abas do Brave na mesma máquina; precisão da sincronização, Safari e internet entre casas ainda precisam de validação. O navegador pode bloquear início automático com som e pedir um clique local.
- Controle experimental de voz na sala aprovada: cada pessoa liga seu microfone, pode silenciar, ajustar o volume da conversa e desligar. A lógica de negociação e encerramento foi verificada com clientes simulados; a permissão real do navegador, o áudio entre duas máquinas e o Safari ainda não foram testados. Sem STUN/TURN configurado, algumas redes não conectarão a voz.
- Registro manual de progresso, assistido, lista e opinião de cada pessoa.
- Ordenação local das recomendações, favorecendo títulos não vistos e afinidade dos dois; cada card apresenta um motivo simples.
- Na sala, **Me surpreenda** oferece até três títulos ainda não vistos. **3 do algoritmo** prioriza as preferências salvas. Sem histórico, ambos começam com sugestões neutras. O rodízio evita repetir uma opção antes de apresentar as outras elegíveis.
- Votação individual de Host e Convidado em cada título, com os nomes definidos no Perfil. Dois votos **Quero ver** no mesmo título produzem o estado **É um match!**. Sem match, há nova rodada, resumo para conversa e indicação manual. A sala online mostra capas, dados dos títulos e participantes em cartões.
- Exportação em JSON dos dados deste navegador.
- Transições de entrada e de foco, elevação dos cards, botões com resposta ao toque e respeito à preferência por movimento reduzido.

Para testar a decisão: clique em **Me surpreenda**; vote nos três cards como Host (Pessoa 1); selecione Convidado (Pessoa 2) e vote nos mesmos cards. Se ambos escolherem **Quero ver** no mesmo título, aparece o match. **Escolher manualmente** cria uma rodada de um título, já aprovada por quem indicou.

Na prévia aberta diretamente como arquivo, os registros ficam no `localStorage` e os papéis são simulados no mesmo navegador. Na sala conectada, o serviço mantém os votos e dados dos dois papéis em memória e atualiza o dashboard de cada aba; o estado desaparece quando o servidor reinicia ou a sala expira. **Ainda não há conexão validada entre Windows e MacBook pela internet.** Sem chave TMDB, os títulos e imagens são fictícios e não representam catálogos dos serviços citados.

## O que ainda precisa ser implementado e validado

1. Instalação do aplicativo para Windows e macOS.
2. Implantar e validar comunicação segura entre as duas pessoas pela internet; o serviço local já existe, mas não foi implantado.
3. Validar e refinar a sincronização do player YouTube; integrar Netflix, Prime Video e Crunchyroll serviço por serviço.
4. Empacotamento e teste real da extensão no Safari do MacBook.
5. Testar a voz entre os dois computadores e configurar STUN/TURN quando a rede exigir; o fluxo local já está implementado.
6. Perfis autenticados e estáveis, persistência e fusão do histórico local; o nome atual é livre e a sala guarda somente dados temporários por papel.
7. Ampliar o catálogo TMDB além do primeiro lote e atualizar a disponibilidade por país/serviço. Identificar links diretos e testar acesso real nos streamings. Veja `../DUOTELA-FONTES-DE-CATALOGO.md`.

A sala online usa o player incorporado do YouTube quando há um link selecionado. A prévia aberta como arquivo continua com controles simulados e não transmite áudio. A voz só aparece na sala online após a entrada ser aprovada; o navegador pedirá permissão de microfone quando a própria pessoa clicar em **Ligar voz**.

## Arquitetura proposta para a próxima etapa

O aplicativo de desktop pode apresentar dashboard, lista e histórico locais. O navegador onde cada pessoa já faz login no serviço reproduz o vídeo. Uma extensão pequena observa o player e envia somente ações como play, pausa, posição e identificador do título; não envia nem retransmite o vídeo. O suporte de cada serviço precisa ser medido em uma matriz real de testes, especialmente no Safari.

**Restrição definida pelo casal: não pagar nada à Apple.** O projeto não deve depender de inscrição no Apple Developer Program, TestFlight ou publicação do nosso app na App Store. Para validar a tecnologia no MacBook, a [Apple permite adicionar temporariamente uma extensão no Safari](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension), mas ela é removida após 24 horas ou quando o Safari é fechado. Essa é uma etapa de teste, não uma solução final de instalação simples. Antes de prometer um produto utilizável no Safari, é preciso confirmar no MacBook um caminho gratuito e aceitável para os dois.

Uma opção gratuita para uso contínuo é o [Userscripts para Safari](https://apps.apple.com/us/app/userscripts/id1463298887?platform=mac): ela instala uma extensão de terceiros já distribuída na App Store e permite adicionar nosso arquivo `extension-spike/userscripts/sessao-a-dois-youtube.user.js` à pasta de scripts. O app consta como gratuito na consulta de 15/10/2026. É uma instalação inicial, com ativação da extensão e acesso ao YouTube no Safari; não foi validada no MacBook. O teste local do script controla apenas o YouTube desta máquina, sem sincronização entre vocês. Veja `extension-spike/README.md`.

**Próxima validação:** testar o script no YouTube real no Windows e, depois, no Safari do MacBook. Se ambos conseguirem ler e controlar play, pausa e tempo, ligar os dois controladores pela internet e só então adicionar voz e ampliar para Netflix, Prime Video e Crunchyroll, cada um com testes próprios.

O Claude Code CLI implementou `src/sync-engine.mjs` e contribuiu com `src/match-engine.js`, o motor isolado de recomendações e votação. O Codex revisou as integrações. Para repetir os testes com Node.js instalado, use `node --test tests/*.test.mjs` dentro desta pasta. O motor de decisão funciona somente com o catálogo fictício e dados deste navegador; o módulo de sincronização ainda não está ligado à interface ou a um player real.

## Modelo de sala e identidade (`src/room-model.js`) — protocolo, não admissão segura

Quem **cria** a sala é o **Host (Pessoa 1)**; quem **entra pelo convite** é o **Convidado (Pessoa 2)**. Se a namorada criar a sala, ela é o Host. O papel nasce de criar/entrar na sala e é deduzido da credencial: nunca vem de um seletor da interface nem de um campo da mensagem. O seletor da prévia local é uma simulação e some no modo real.

**Papéis canônicos no fio: `host` e `guest`.** O código legado (`src/match-engine.js` e `index.html`) ainda usa `you`/`partner`; o mapeamento temporário é `host = you`, `guest = partner` (`RoomModel.LEGACY_ROLE_MAP`). Ainda não foi feita refatoração.

**Este módulo é um modelo puro, separado do serviço.** O servidor experimental está em `server/` e usa seu próprio estado em memória. Nenhum deles foi auditado ou implantado; uso pela internet exige TLS, limite de taxa no proxy e testes em duas redes. Segredos não devem ir para `localStorage` nem logs.

Limites exatos:

- Código público de 6 dígitos (exibição, **não é segredo**; a unicidade deve ser garantida pelo servidor).
- Segredo de convite, credencial do Host e do Convidado: 32 bytes (256 bits) de `crypto.getRandomValues`/`randomFillSync`; sem fonte segura, o modelo recusa gerar. `Math.random` nunca é usado. Os valores são distintos.
- Convite válido por 15 min; sala válida por 4 h (configuráveis); depois disso nada é aceito.
- Convite de uso único no modelo: ele emite uma única credencial de Convidado; tentativas seguintes dão `room_full`. Um servidor real ainda precisa impedir conexões simultâneas que reutilizem a mesma credencial roubada ou copiada.
- Mensagem: JSON com exatamente `v` (=1), `room`, `type`, `seq`, `payload`; no máximo 2048 bytes UTF-8. Qualquer campo extra, inclusive `role`/`from`/`sender`/`identity`, é recusado.
- Tipos: `vote`, `round` (só Host), `playback`, `history`; payloads estritos (ids até 64 caracteres, até 3 títulos por rodada, posição 0–86400 s, progresso inteiro 0–100).
- `seq`: inteiro de 1 a 2147483647, estritamente crescente por papel; repetido ou menor é recusado. Falhas não consomem `seq`.
- Fora do escopo: limite de tentativas de entrada, guardar hash, renovar/revogar credencial, reconexão, ordenação entre papéis, criptografia de ponta a ponta.

As credenciais são propriedades acessíveis por nome, porém não entram em `JSON.stringify` do resultado direto de criação/entrada. Isso reduz vazamentos acidentais; não substitui proteção de memória, transporte e logs no serviço real. Um objeto montado manualmente com essas credenciais ainda pode expô-las.

Testes: `node --test tests/room-model.test.mjs tests/match-engine.test.mjs tests/sync-engine.test.mjs`.

## Serviço de sala online (`server/`) — NÃO implantado, não testado pela internet

Serviço mínimo (Node 24, só módulos nativos) com HTTP + long polling, `server/client.js` e painel em `server/online-ui.js`. O Host cria a sala; o Convidado entra com o convite e **só participa depois da aprovação do Host**. O papel vem da credencial emitida pelo servidor; o nome do Perfil é apenas visual. A interface `index.html` usa o serviço quando aberta pelo endereço local informado acima; aberta como arquivo, mantém a simulação offline. Detalhes, protocolo, reconexão e limitações em `server/README.md`. Testes: `node --test tests/*.test.mjs`. O painel online foi conferido no navegador local em duas abas; ainda faltam MacBook, Safari e duas redes.
## Catálogo real do TMDB no Windows

Dê dois cliques em `iniciar-tmdb.cmd` e cole o **API Read Access Token** na janela do terminal. Os caracteres não aparecem enquanto você digita. O token fica só na memória desse processo, não no código nem na interface. Abra `http://127.0.0.1:8789/`. Feche o terminal para parar o serviço. Se a porta 8789 já estiver em uso, feche a prévia anterior antes de iniciar outra.

Nesta prévia, o catálogo local com pôsteres aparece mesmo sem token. A API key v3 não é usada aqui. Se um token foi enviado em uma conversa, revogue e gere outro no TMDB depois do teste.

## Sala para 4 pessoas e ponte Netflix (prévia local, não publicada)

- Sala para até 4 participantes: veja `server/README.md` ("Sala para até 4 pessoas").
- Ponte Netflix experimental para Chrome/Edge: `extension-bridge/README.md`. Safari: `extension-bridge/SAFARI.md` (não suportado nesta etapa).
- Testes: `node --test tests/*.mjs`, `node --test extension-bridge/tests/*.cjs`, `node tools/e2e-room-4p.mjs`, `node tools/e2e-netflix-bridge.mjs`.
