# Spike de extensão — controle local do YouTube e da Netflix

Experimento pequeno para o Dalari Cine. Ele testa a leitura e o controle do `<video>` na aba atual do YouTube ou da Netflix. **Não sincroniza nada entre dispositivos** e ainda não abre um título para host e convidado.

## O que existe

| Arquivo | Função |
| --- | --- |
| `manifest.json` | Manifest V3, `permissions: []`, content script em YouTube e em `www.netflix.com/watch/*`. |
| `src/video-controller.js` | Controlador puro e testável: encontra o `<video>` e trata `GET_STATE`, `PLAY`, `PAUSE`, `SEEK_TO_SECONDS`. |
| `src/content-script.js` | Liga o controlador a `runtime.onMessage`; ignora remetentes que não sejam a própria extensão. |
| `popup/` | Popup mínimo: estado atual, Play, Pause, Atualizar e "Ir para" (segundos). |
| `tests/extension-spike.test.cjs` | 19 testes em Node com vídeo/DOM falsos. |
| `userscripts/sessao-a-dois-youtube.user.js` | Rota separada para Safari: um único userscript autônomo (ver "Rota Userscripts"). |
| `tests/userscript.test.cjs` | Testes em Node (VM + DOM falso) do userscript: controles, sem vídeo, escopo dos metadados. |
| `userscripts/sessao-a-dois-netflix.user.js` | Rota experimental para Safari na página de reprodução da Netflix. |
| `tests/netflix.test.cjs` e `tests/review-fixes.test.cjs` | Testes com DOM e vídeo falsos para Netflix e erros do player. |
| `src/netflix-room-sync-core.js` | Núcleo puro para validar snapshots da sala, controlar um player injetado e filtrar eco; **ainda não é carregado pela extensão**. |
| `tests/netflix-room-sync-core*.test.cjs` | Testes do núcleo com player falso, inclusive erros, troca de título e encerramento durante comandos. |

## O que funciona (verificado por testes automatizados com vídeo falso)

- `GET_STATE`: devolve `hasVideo`, `videoId` (da URL), `isPlaying`, `isEnded`, `currentTimeSeconds`, `durationSeconds`, `readyState`. Sem vídeo, responde `hasVideo: false`.
- `PLAY` / `PAUSE`. Se o navegador bloquear o play (política de autoplay / falta de gesto), a resposta é `PLAY_BLOCKED_BY_BROWSER`; também há `PLAY_INTERRUPTED` e `PLAY_FAILED`.
- `SEEK_TO_SECONDS`: aceita apenas número primitivo finito `>= 0`; é limitado à duração. Strings, `NaN`, `Infinity`, negativos, objetos etc. dão `INVALID_SEEK_SECONDS`. Duração desconhecida (ao vivo ou carregando) dá `DURATION_UNKNOWN`.
- Mensagem inválida ou tipo desconhecido é recusado sem efeito.
- Sem vídeo: ações devolvem `NO_VIDEO`.
- Navegação SPA: o vídeo e a URL são relidos a cada mensagem. Na Netflix, o script ainda precisa ter sido injetado ao carregar uma rota `/watch/*`; abrir essa rota a partir de `/browse` pode exigir recarregar a aba.
- Superfície mínima, checada por teste: nenhuma permissão, nenhum `host_permissions`, nenhum background, nenhum `fetch`/WebSocket/storage no código, nenhuma dependência.

## Como rodar os testes

Requer Node.js (testado com v24; nenhuma instalação de pacotes). Dentro desta pasta:

```
node --test tests/*.cjs
```

O conjunto completo tem **87 testes**: os 49 do controle local mais 38 do núcleo de sincronização. Todos usam player ou DOM simulados.

## Núcleo de sincronização em preparação

`src/netflix-room-sync-core.js` recebe snapshots já autenticados da sala por uma função chamadora e aceita apenas a sala, o papel, o título e o `watchId` esperados. Ele descarta versões antigas, evita repetir eventos causados por comandos remotos e cancela a sequência ao sair da sala. Quando o navegador bloquear o play, oferece `resumePending()` para uma tentativa explícita a partir de um clique; falhas de seek/play/pause exigem `retryLast()` explícito. Erros devolvem códigos fixos, sem copiar mensagens que poderiam conter credenciais.

Esse módulo **não está no `manifest.json` nem conectado à página Dalari Cine ou à Netflix**. Ele não abre títulos, não envia rede e não sincroniza duas pessoas ainda. Para ativá-lo, faltam validar o player real e construir a ponte entre a aba da sala e a aba do streaming com revisão de origem e permissões. A aba Dalari Cine deverá permanecer responsável pela credencial; a página Netflix não deve recebê-la.

## Netflix: teste local experimental

No Chrome ou Edge, carregue a pasta `extension-spike` em `chrome://extensions` ou `edge://extensions` com o modo do desenvolvedor ativo. Abra diretamente um endereço `https://www.netflix.com/watch/<id>` e recarregue a aba após instalar a extensão. O popup pode consultar o estado e tentar Play, Pause e Ir para. O script só é injetado nessa rota; ao navegar da página inicial da Netflix para um título sem recarregar, talvez seja preciso recarregar a aba.

Para um teste futuro no Safari sem conta paga da Apple, o arquivo `userscripts/sessao-a-dois-netflix.user.js` foi preparado para o app Userscripts. Ele mostra um painel com Play, Pause, Atualizar e +30 s apenas na rota `/watch/*`. A instalação e a execução no Mac **não foram verificadas**.

Os **49 testes automatizados** passam com vídeo e DOM simulados. Isso não confirma que os controles funcionam na Netflix real: seleção do player, reprodução protegida, bloqueio de autoplay e avanço precisam de teste manual. O código não lê login/cookies, não usa APIs privadas da Netflix e não envia dados pela rede. Mesmo após um teste local bem-sucedido, faltará conectar os eventos do player à sala, relacionar o ID da Netflix ao título do catálogo e abrir o mesmo título para os participantes.

## Teste manual no Chrome ou Edge

1. Abra `chrome://extensions` (Edge: `edge://extensions`) e ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** e escolha esta pasta (`extension-spike`).
3. Abra um vídeo em `https://www.youtube.com/watch?v=...`. Se a aba já estava aberta antes de carregar a extensão, recarregue-a.
4. Clique no ícone da extensão: o popup mostra o estado. Teste Play, Pause, "Ir para" com `30`, e com valores inválidos (`abc`, `-5`).
5. Clique em outro vídeo dentro do YouTube (navegação SPA) e use "Atualizar": o id deve mudar.
6. Na home, sem vídeo, o popup deve dizer que não há vídeo.
7. Autoplay: abra um vídeo em aba nova sem clicar na página e use Play no popup. Não sabemos se o navegador vai bloquear ou permitir; registre o resultado (`PLAY_BLOCKED_BY_BROWSER` ou sucesso) em vez de assumir.

## Teste temporário no Safari (não executado — não temos Mac)

O `LEIA-ME.md` do protótipo registra a restrição de **não pagar nada à Apple** e que a [Apple permite adicionar temporariamente uma extensão no Safari](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension); essa extensão é removida após 24 horas ou quando o Safari é fechado. Isso é uma etapa de teste, não uma instalação definitiva.

Passos para **teste temporário**, conforme a documentação da Apple; não exigem Xcode nem conta paga:

1. No Safari, abra **Safari > Ajustes > Avançado** e ative **Mostrar recursos para desenvolvedores**, se a aba Desenvolvedor ainda não estiver visível.
2. Abra **Safari > Ajustes > Desenvolvedor > Adicionar extensão temporária** e selecione a pasta `extension-spike` ou o ZIP dela. Se o Safari solicitar, autorize extensões não assinadas.
3. Em **Safari > Ajustes > Extensões**, habilite a extensão temporária e conceda acesso ao YouTube quando solicitado.
4. Abra um vídeo do YouTube, clique no ícone da extensão e tente Atualizar, Play, Pause e Ir para 30 segundos. Depois troque de vídeo dentro do YouTube e confira o novo identificador.

A Apple informa que a extensão temporária some após 24 horas ou ao fechar o Safari. A opção para permitir extensões não assinadas também precisa ser reativada após fechar o Safari. Portanto este procedimento **não serve como instalação definitiva simples**.

Antes de qualquer afirmação sobre o Safari, preencha o resultado real desta lista no Mac.

## Rota Userscripts (Safari, sem pagar à Apple)

Alternativa separada da extensão acima, pensada para quem usa só Safari. Nenhum dos arquivos da extensão (`manifest.json`, `src/`, `popup/`) é usado nesta rota; o userscript é um arquivo único e autônomo.

**Custo.** Nenhuma conta paga da Apple é necessária para esta rota de terceiros: o app Userscripts é gratuito na App Store oficial (listagem conferida). A instalação do app é feita **uma única vez**. Qualquer afirmação de que seria preciso uma conta paga da Apple não vale para esta rota; ela só se aplicaria a empacotar e assinar a *nossa* extensão com Xcode, o que não é necessário aqui.

**Arquivo:** `userscripts/sessao-a-dois-youtube.user.js`. O README do projeto Userscripts (upstream) informa que um arquivo `.user.js` pode ser salvo diretamente na pasta de scripts do app.

**O que o script faz.** `@match` apenas `https://www.youtube.com/*` e `https://m.youtube.com/*`; `@grant none`; sem `@require`, `@connect` ou URL de atualização; sem rede, armazenamento ou credenciais. Mostra um painel compacto (canto inferior direito, com rótulos ARIA e alvos de toque de 44 px) com o estado atual (tocando/pausado, tempo/duração) e os botões **Play**, **Pause**, **Atualizar** e **+30 s** (avança 30 segundos, limitado à duração; recusado em vídeo ao vivo). O `<video>` é procurado de novo a cada ação e a cada segundo, então a navegação interna do YouTube (SPA) não prende o painel a um vídeo antigo. Sem vídeo, os botões mostram "Nenhum vídeo encontrado".

**Passos previstos (não verificados):**

1. Instale o app [Userscripts pela App Store](https://apps.apple.com/us/app/userscripts/id1463298887?platform=mac) (gratuito na consulta de 15/10/2026, uma vez). No macOS atual, o projeto informa que a pasta padrão de scripts é criada automaticamente; abra o app para conferir.
2. Salve `sessao-a-dois-youtube.user.js` na pasta de scripts indicada pelo app. O [README oficial do Userscripts](https://github.com/quoid/userscripts#usage) também descreve essa forma de importar.
3. Ainda assim é preciso **habilitar a extensão do Safari** (Safari > Ajustes > Extensões) e **permitir o acesso a `youtube.com`** quando o Safari pedir. Isso continua obrigatório e é feito pelo usuário.
4. Abra um vídeo do YouTube e confira o painel.

**Limites desta rota:**

- **Ainda não houve teste em um Mac real.** Só há testes automatizados em Node com DOM e vídeo falsos; não afirmamos que funciona no Safari nem no YouTube real (anúncios, Shorts, ao vivo e mudanças do YouTube não foram exercitados). O procedimento de instalação foi conferido na documentação do Userscripts, mas não executado num Mac.
- **Não há sincronização entre dispositivos.** Cada pessoa controla apenas o vídeo da própria aba, localmente, e precisa instalar no próprio aparelho.

## Limites precisos

### Verificação de 15/10/2026 no Brave (Windows)

Em uma aba real do YouTube já aberta pelo usuário, o seletor `#movie_player video.html5-main-video` encontrou o elemento de vídeo. A leitura somente de observação retornou tempo, duração e estado pausado. **Não carregamos a extensão nem executamos Play/Pause por ela no Brave**, então isso confirma apenas a localização e leitura do player naquele vídeo, não a integração completa.

O acesso automatizado à prévia local `file://` foi recusado pela política do navegador de teste. Não foi tentado outro caminho para contornar esse bloqueio; a aparência e os cliques da prévia continuam sem validação visual automatizada.

- **Safari não foi testado. Não afirmamos compatibilidade com Safari.** O código usa `globalThis.browser || globalThis.chrome` e `async`/`Promise`, mas isso é apenas intenção.
- Os testes usam vídeo e DOM **falsos**. Eles **não** provam comportamento no YouTube real nem em Chrome/Edge: seletores do player, anúncios, miniplayer, Shorts, vídeo ao vivo e mudanças futuras do YouTube não foram exercitados. Durante anúncios, o `<video>` pode ser o do anúncio.
- Controla apenas o vídeo da aba ativa, no frame principal (`all_frames: false`). Sem rede, sem backend, sem login, sem armazenamento, sem relé, sem transmissão de mídia.
- **Não há sincronização entre dispositivos.** Também não há detecção automática de eventos (play/pause feitos pelo usuário não são notificados), apenas consulta e comandos pelo popup.
- Seek só funciona com duração finita; ao vivo não é suportado.
- `videoId` vem da URL (`watch?v=` ou `/shorts/`); outros formatos aparecem como desconhecido.
- Sem ícones nem empacotamento assinado. Para Chrome/Edge o uso é só "carregar sem compactação". O ZIP será gerado depois da revisão.
- O erro "Sem resposta" no popup cobre várias causas (aba fora do YouTube, content script não carregado) sem distingui-las.
