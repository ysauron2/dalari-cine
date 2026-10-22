# Serviço de sala Dalari Cine (rascunho, NÃO implantado)

Node 24, sem dependências. `node server/index.js` escuta em `127.0.0.1:8787` (HTTP puro). Recusa interface não-loopback salvo `ALLOW_NON_LOOPBACK=1`.

Para um teste local da interface, abra `http://127.0.0.1:8787/` em duas abas, salve um nome em **Perfil** em cada uma, crie a sala na primeira e peça entrada na segunda. A interface recebe snapshots por long polling e mostra nomes, capas, votos e match. O Host escolhe uma plataforma compartilhada; ambos podem buscar e indicar títulos do catálogo. No YouTube, qualquer participante pode abrir um vídeo por link ou busca para os dois sem outra aprovação. Após match de um título do catálogo, qualquer participante pode escolher seu vídeo exato. Play e pausa são transmitidos à sala. O navegador pode exigir um clique local para começar vídeo com som; isso não é uma aprovação do parceiro. O nome pode ser alterado durante a sessão. Reprodução e pausa foram conferidas em duas abas do Brave na mesma máquina; ainda faltam teste em duas redes, precisão de sincronização e compatibilidade Safari.

## Catálogo TMDB opcional

Se `TMDB_READ_ACCESS_TOKEN` estiver presente ao iniciar `node server/index.js`, `tmdb-catalog.js` consulta as listas Discover e gêneros de filmes, séries e animações japonesas no TMDB. A credencial vai somente no cabeçalho da requisição do processo Node. O servidor entrega ao navegador o catálogo normalizado e usa **a mesma lista** para validar votos, histórico e rodadas da sala. A chave canônica é `tmdb:movie:ID` ou `tmdb:tv:ID`, com deduplicação entre séries e animes. A interface mostra filtros derivados dos gêneros retornados, sinopse, pôster, nota pública quando houver votos suficientes e link para a ficha TMDB. As recomendações usam os gêneros/tags, avaliações e progresso registrados no Dalari Cine; nota pública tem peso pequeno.

Sem a variável, esta prévia usa o catálogo local em `data/tmdb-catalog-br.json` quando disponível; se o arquivo não existir, usa o catálogo fictício. O catálogo local é uma consulta anterior e pode ficar desatualizado. Os dados do TMDB são carregados uma vez ao iniciar o serviço; reiniciar o servidor encerra as salas em memória. O filtro de disponibilidade brasileira é uma indicação do TMDB, não uma garantia de acesso à conta, de link direto ao título ou de permissão para incorporá-lo. **Não coloque a credencial em `index.html`, GitHub ou URLs.** Veja o comando PowerShell no `LEIA-ME.md`.

## YouTube opcional

O player incorporado usa a IFrame Player API e não exige chave. Ele só reproduz links que o YouTube permite incorporar; a seleção de título TMDB e a do vídeo ainda são manuais. A busca por palavras dentro da sala usa a YouTube Data API e só aparece quando `YOUTUBE_DATA_API_KEY` está definida no processo Node. A chave nunca é enviada ao navegador. A rota de busca exige credencial de uma sala ativa, limita consultas por IP e retorna apenas ID, título, canal e imagem. Sem a chave, qualquer participante pode colar um link HTTPS e abrir o vídeo para ambos. O usuário deve obter sua própria chave no Google Cloud; o Dalari Cine não cria uma automaticamente.

## Sala para até 4 pessoas

`POST /v1/rooms {displayName?, maxParticipants?}` aceita 2 (padrão, fluxo de dupla inalterado) a 4 participantes; a interface cria salas de 4. Identidades estáveis por credencial: `host`, `guest`, `guest2`, `guest3` (o papel vem sempre da credencial; nome e código nunca autorizam). Cada pessoa entra com um convite de uso único e exige aprovação do Host **só na entrada** (`admission {decision, participant}`; `participant` é obrigatório quando houver mais de um candidato). O Host pode gerar convites seguidos até lotar (um convite ativo por vez; gerar outro cancela o anterior); pendentes ocupam vaga, e um quinto pedido recebe `room_full`. Sair: `POST /leave` (convidado) ou remoção pelo Host; credencial de quem saiu só lê o estado terminal (`guest_left`/`guest_removed`) até a vaga ser reocupada, quando passa a dar 401.

**Votos e composição.** O match exige "sim" de **todos os participantes da rodada** (`round.participants`). Quando a composição muda (entrada aprovada, saída, remoção) **antes do match**, a mesma seleção é reiniciada com votos limpos (`roundNumber + 1`, votos antigos viram `stale_round`) e o snapshot traz `notice {kind:'round_restarted', reason, name}`. **Depois do match** o título e a mídia são mantidos; `notice` registra `joined_after_match`/`left_after_match` e `round.late` lista quem entrou depois (essa pessoa controla a mídia, mas não vota naquela rodada). Quem está **desconectado continua na rodada**: a presença fica `false`, o match espera por essa pessoa e só o Host pode removê-la. Preferências salvas (`viewing`) são por pessoa; o ranking usa o Host como "você" e os convidados como "parceiro" (veto de qualquer convidado vale) — aproximação, não personalização por pessoa.

**Voz em malha.** Cada par de participantes com voz ligada tem sessão e sinalização próprias (`voice.links[]`); `voice.offer`/`voice.answer` levam `to` quando há mais de duas pessoas (quem tem o menor índice oferece). Cada pessoa só recebe o SDP dos pares em que é uma das pontas; mudar o microfone de alguém reinicia só os pares dele. Campos legados da dupla (`voice.session/hasOffer/hasAnswer/remote`) continuam presentes quando há exatamente dois participantes.

## Contrato Netflix

O serviço agora reconhece `media.netflix {titleId,watchId}` após match na plataforma Netflix e `playback.netflix {titleId,watchId,action,positionSec}` para o mesmo título e ID. `watchId` deve ser uma string de 1 a 12 dígitos; o servidor não descobre nem confirma a qual título pertence. O cliente expõe `selectNetflixTitle` e `playbackNetflix` para essa etapa futura.

**Ponte experimental (Chrome/Edge).** A interface usa essas ações por meio da extensão local de teste em `extension-bridge/` (veja o README dela): a credencial da sala fica só na aba Dalari Cine; a extensão recebe uma visão mínima (título, `watchId`, play/pause/seek). Testada com DOM falso e com Chromium real contra uma página falsa; **não** testada na Netflix real nem no Safari.

## Código curto (`p2p-rendezvous.js`)

O Host abre **Convidar → Gerar código** e recebe algo como `K7QM-93XP` (8 caracteres, uso único, 15 minutos). O convidado só digita o código no campo de convite e a conexão abre sozinha; o Host aprova a entrada como sempre. Por baixo, os dois aparelhos derivam do código (PBKDF2, 200 mil iterações) dois tópicos e uma chave AES-GCM. O convidado publica a oferta de conexão cifrada num tópico de um **serviço de encontro** (por padrão `https://ntfy.sh`, gratuito e sem conta); o Host, que já escuta, responde cifrado no outro, com um nonce que amarra a resposta àquela oferta. O serviço vê só texto cifrado, os IPs de quem se conecta e o tamanho das mensagens; sem o código não se acha o tópico nem se lê ou forja mensagem. O Host aceita só a primeira oferta válida.

- **Dependência externa:** se o serviço estiver fora do ar ou bloqueado, use a **conexão manual** (códigos grandes, abaixo, no mesmo diálogo). O código não vale entre dois Hosts diferentes nem depois de usado.
- **Outro relé ou o seu:** `DUOTELA_RELAY_ORIGINS=https://meu-ntfy.exemplo.com` (lista separada por vírgula) libera a origem na CSP; no navegador, `localStorage['duotela-relay']` escolhe qual usar. Há um relé falso de teste em `tools/fake-relay.mjs`.
- **Limites:** exige `crypto.subtle` (127.0.0.1, localhost ou https). O comportamento do ntfy.sh real **não foi verificado** aqui; foi testado com um relé falso que imita a API.

## Conexão direta sem servidor (`p2p-link.js`)

Para duas pessoas em casas diferentes **sem VPS**: o serviço da sala roda no aparelho do Host (o app já o inicia em `127.0.0.1`). O Host abre **Convidar → Gerar convite de conexão direta** e envia o código `DT1.…` (já inclui o convite da sala) por qualquer canal. O convidado cola o código em **Entrar como Convidado** e devolve o código de resposta; o Host cola a resposta e clica **Conectar**. Abre-se um canal WebRTC direto; por ele o convidado chama, no serviço do Host, **somente** as rotas `state`, `ice`, `join`, `actions`, `profile`, `leave` e `youtube/search` de uma sala (criar sala, admissão, convite e encerrar ficam só com o Host). O serviço continua autenticando por token e convite, e o Host ainda aprova a entrada. A voz negocia pela mesma sala; o áudio vai direto entre os aparelhos.

Limites: usa só STUN (padrão: Google) — redes que bloqueiam conexão direta (CGNAT, rede corporativa) podem não abrir sem TURN. O canal é criptografado (DTLS), mas o código de oferta/resposta contém IPs dos aparelhos e o convite: trate-o como senha temporária; o convite expira em 15 min e vale para uma pessoa. Se o Host fechar o app, a sala some (estado em memória).

## Voz: quem fala, ducking, volume por pessoa e push-to-talk

- **Quem está falando:** o avatar de quem fala ganha um brilho verde (o seu também, se o microfone estiver aberto). O nível vem de `getStats()` (`audioLevel`): liga acima de 0,02, desliga abaixo de 0,01 depois de 500 ms.
- **Ducking:** quando *outra pessoa* fala, o vídeo abaixa (padrão: para 35% do volume que você tinha), desce em ~150 ms e sobe em ~700 ms, com 600 ms de "resto" para não pular entre palavras. Funciona no player do YouTube e na Netflix do aplicativo (o app ajusta o volume do `<video>`). Liga, desliga e escolhe o nível em **⚙ Áudio → Vídeo**.
- **Volume por pessoa:** um controle para cada participante em **⚙ Áudio → Volume por pessoa** (multiplica o volume geral; vale só nesta sessão).
- **Push-to-talk:** em **⚙ Áudio → Microfone**, ligue "Falar apertando uma tecla" e escolha a tecla (padrão: a de crase). O microfone fica fechado até apertar; "Segurar para falar" também serve com o mouse ou o toque. No aplicativo a tecla funciona até com a Netflix em foco; no navegador, só com a página em foco, e ignorada ao digitar em campos de texto. Uma tecla "presa" solta sozinha após 3 minutos.

## Voz pela internet: STUN/TURN

A voz usa a lista de servidores ICE que o serviço entrega a participantes **autenticados e aprovados** em `GET /v1/rooms/:code/ice` (pendentes recebem 403). Configure no processo Node:

- Sem variáveis: só `stun:stun.l.google.com:19302` (revela o IP público ao provedor STUN). Resolve boa parte das redes, não todas.
- `ICE_SERVERS_JSON`: lista JSON `[{"urls":"stun:…"},{"urls":"turn:…","username":"…","credential":"…"}]` (substitui o padrão; serve para um TURN gerenciado). `[]` desliga.
- `TURN_URLS` (vírgulas) + `TURN_SECRET` (≥ 16 caracteres) + `TURN_TTL_SEC` (padrão 6 h): para um **coturn** próprio com `use-auth-secret`/`static-auth-secret` igual a `TURN_SECRET`. O servidor gera usuário/credencial temporários (HMAC-SHA1) por participante; o segredo nunca vai ao navegador.

Sem TURN, redes simétricas/corporativas/CGNAT podem não conectar. Isso **não foi testado entre redes reais** nesta máquina.

## Voz experimental

Depois da aprovação da entrada, cada pessoa pode clicar em **Ligar voz**. O navegador pede acesso ao microfone apenas para quem clicou. A sala troca ofertas/respostas WebRTC autenticadas; o servidor não recebe o áudio. Há botões de silenciar, desligar, tentar novamente e volume individual da conversa. A negociação usa SDP com candidatos ICE completos, sem gravação ou persistência. `voice.ready`, `voice.offer`, `voice.answer` e `voice.retry` dispensam novas aprovações do Host. Desligar a voz para imediatamente a captura local.

O fluxo foi testado com quatro clientes simulados, testes de protocolo e, em Chromium real (mídia falsa do próprio navegador, mesma máquina), com 4 abas formando 6 ligações WebRTC conectadas. **Ainda não houve chamada real entre aparelhos/redes diferentes nem validação no Safari.** A configuração ICE atual não inclui STUN/TURN; algumas redes não estabelecerão o áudio até isso ser configurado e testado. O serviço segue restrito ao loopback HTTP nesta prévia.

> **HTTP local não é seguro pela internet.** Qualquer uso real exige HTTPS (e WSS se um dia houver WebSocket) terminado por proxy reverso confiável, com limite de taxa/conexões, cabeçalhos de proxy tratados com cuidado (o serviço **não** lê `X-Forwarded-For`; o limite por IP embutido enxerga só o IP do proxy) e uma revisão de segurança. O cliente (`client.js`) só aceita `https://`, exceto loopback.

## Modelo

- **Código de 6 dígitos**: localizador público, nunca autoriza nada.
- **Credencial do Host** (`hostToken`) e **segredo de convite** (`inviteSecret`): 32 bytes de `crypto.randomBytes` (256 bits), distintos. O **Convidado** recebe um `guestToken` próprio ao pedir entrada. O servidor guarda só SHA-256 (comparação em tempo constante). Tokens vão apenas no cabeçalho `Authorization: Bearer`; query com `token`/`secret` etc. é recusada; o log (`logger`) recebe só `{method, route-modelo, status}`.
- **Admissão**: convite de uso único e validade de 15 min. Entrar com o convite cria um pedido *pendente*; o Host aprova/nega em até 5 min (`/admission` com `approve|deny|remove`). Pendente não vê nem altera a sala. Capacidade de 2 a 4 pessoas (ver "Sala para até 4 pessoas"); reuso do convite → `invite_used` (ou `invalid_invite` se foi substituído), sala cheia → `room_full`. Tentativas erradas recebem resposta uniforme e limite por IP; não travam o convite legítimo. `/invite` (Host) emite novo convite enquanto houver vaga (pendentes contam como vaga) e substitui o convite anterior não usado.
- **Sala**: expira em 4 h (410 `room_expired`, removida após 60 s). Host pode fechar. Tudo em memória.

## API (JSON, `Content-Type: application/json`, corpo ≤ 4 KiB; SDP de voz até 32 KiB na rota de ações)

| Rota | Quem | Efeito |
|---|---|---|
| `POST /v1/rooms` `{displayName?, maxParticipants?}` | qualquer | cria sala → `code, hostToken, inviteSecret, …` (mostrados uma vez) |
| `POST /v1/rooms/:code/join` `{inviteSecret,displayName?}` | portador do convite | → `guestToken`, status `pending_approval` |
| `POST /v1/rooms/:code/profile` `{displayName}` | papel autenticado | altera nome visível (2–32 caracteres) |
| `POST /v1/rooms/:code/admission` `{decision, participant?}` | Host | approve / deny / remove |
| `POST /v1/rooms/:code/leave` | convidado | sai da sala |
| `POST /v1/rooms/:code/invite` | Host | novo convite |
| `POST /v1/rooms/:code/close` | Host | encerra |
| `GET /v1/rooms/:code/state?after=N&wait=S` | ambos | snapshot se `revision > N`; senão espera até S ≤ 25 s |
| `POST /v1/rooms/:code/actions` `{v:1, clientSeq, type, payload}` | ambos | ação (abaixo) |

Ações: `platform.select {platform}` (Host), `round.start {mode}` (Host; filtra o catálogo pela plataforma), `round.manual {titleId}`, `vote {round,titleId,vote}`, `media.youtube {titleId,videoId}` (Host ou Convidado, após match em YouTube), `video.open {videoId,title}` (Host ou Convidado; abre vídeo direto sem voto), `playback {titleId,videoId,action,positionSec}` (após seleção do vídeo YouTube), `media.netflix {titleId,watchId}` e `playback.netflix {titleId,watchId,action,positionSec}` (após match em Netflix; contrato sem player), `viewing {titleId,progress,rating,listed}` (por papel), `voice.ready {ready}`, `voice.retry {}`, `voice.offer {session,sdp,to?}` (quem tem o menor índice no par), `voice.answer {session,sdp,to?}` (o outro). A escolha da mídia cria `playback` em `playing`, posição 0, como estado desejado da sala; isso não comprova reprodução no navegador. Plataformas: `youtube`, `netflix`, `prime`, `crunchyroll`. Títulos TMDB precisam existir no catálogo da sala. `GET /v1/rooms/:code/youtube/search?q=...` é opcional, requer a chave no servidor e uma sala ativa em YouTube. Campos de identidade (`role`, `from`, `host`, `token`…) no envelope → 400.

**Snapshot canônico** (`revision` monotônico): status, plataforma, rodada (picks, participantes, votos por participante, resultado), `notice`, `selectedMatch`, `media`, `playback`, `viewing`, estado da voz e nomes por papel, presença, `yourLastSeq`; Host também vê estado do convite e pedido pendente. Cada papel recebe somente o SDP remoto necessário à negociação. Nunca contém credenciais ou hashes. O nome não autentica a pessoa: qualquer portador do convite pode escolher um nome, e o Host deve conferir antes de aprovar. Participantes aprovados veem o `viewing` uns dos outros.

**Sequência**: `clientSeq` estritamente crescente por papel. Igual ao último e com a mesma ação → ack `duplicate:true` sem reaplicar; igual com conteúdo diferente → 409 `seq_conflict`; menor → 409 `stale_seq`. Ação rejeitada não consome seq. Votos levam o número da rodada (`stale_round`). Match trava a rodada (`round_locked`).

## Reconexão

- Cliente reenvia a mesma ação com o mesmo `clientSeq` após falha de rede (idempotente) e reconecta o long poll com backoff (0,5–8 s) usando `after=<última revision>`; a primeira resposta traz o snapshot atual e `yourLastSeq`.
- Um papel = um long poll ativo: novo long poll com a mesma credencial substitui o anterior, que recebe 409 `session_replaced`. Isso **não impede** que alguém com uma cópia da credencial faça outras chamadas simultâneas; a credencial continua sendo um segredo de acesso.
- 401/410 ou reinício do servidor (estado em memória) = sessão perdida; é preciso criar nova sala. `client.resume()` aceita credencial guardada pelo chamador; o módulo não usa `localStorage`.
- Presença = visto nos últimos 45 s; não gera nova `revision`.

## Origin/CORS

Requisição sem `Origin` (clientes não-navegador) passa. Com `Origin`, só se estiver em `ALLOWED_ORIGINS` ou for a origem da interface local `http://127.0.0.1:<porta>` quando `servePrototype` está ativo; preflight respondido só para origens permitidas. Origin não é autenticação. A rota estática usa uma lista restrita de arquivos do protótipo.

## Limites embutidos

Corpo 4096 B (até 32768 B para ações `voice.offer`/`voice.answer`, com SDP limitado a 24000 caracteres), 500 salas, 200 long polls simultâneos (503 acima), 10 criações, 20 entradas e 12 buscas YouTube/min por IP de socket, 600 req/min geral, timeouts de cabeçalho/requisição.

## Não implementado / não validado

Implantação, TLS, proxy e limite de taxa real; teste de voz em duas máquinas/redes (a malha foi testada só em uma máquina); WebSocket; TURN/STUN configurados; sincronização precisa sob latência variável; Safari; players de Netflix, Prime Video e Crunchyroll; identificação automática do vídeo exato a partir do TMDB; persistência, múltiplas instâncias; perfis/identidade autenticados e estáveis; consentimento granular de dados compartilhados; auditoria de segurança independente.
