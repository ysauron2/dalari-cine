# Ponte Dalari Cine ↔ Netflix (Chrome/Edge, experimental, teste local)

Extensão MV3 **sem publicação** que liga a aba da sala Dalari Cine às abas da Netflix do mesmo navegador. Cada pessoa assiste na **própria conta**, em `netflix.com`; o Dalari Cine sincroniza só **título (`watchId`), play, pause e seek**. Não retransmite vídeo.

> Status: testada com DOM falso e com Chromium real contra uma página **falsa** em `https://www.netflix.com/watch/<id>` (DNS externo bloqueado). **Não** foi testada na Netflix real (login, player, DRM) nem entre máquinas/redes diferentes. **Safari: não suportado nesta etapa** — veja `SAFARI.md`.

## Instalar para teste (Chrome ou Edge no Windows/Mac/Linux)

1. Rode o serviço local: `node server/index.js` e abra `http://127.0.0.1:8787/`.
2. `chrome://extensions` (ou `edge://extensions`) → **Modo do desenvolvedor** → **Carregar sem compactação** → escolha esta pasta (`extension-bridge`).
3. Recarregue a aba Dalari Cine. Na sala, com a plataforma **Netflix** e um match, a aba **Netflix** do painel lateral mostra "Extensão ligada".

A extensão só atua em `https://www.netflix.com/watch/*` e em `http://127.0.0.1/*` / `http://localhost/*` (qualquer porta). Para uma origem HTTPS real do Dalari Cine, acrescente a origem em `manifest.json` (`content_scripts[1].matches`) **e** em `ROOM_ORIGIN_RE` de `src/bridge-protocol.js`.

## Fluxo (depois do match na Netflix)

1. Uma pessoa abre o título correto **na Netflix** (o filme ou o *episódio* que vão ver) e volta à aba Dalari Cine.
2. O painel lista as abas `/watch/<id>` abertas **neste navegador**. A pessoa marca **"Confirmo que /watch/<id> é «título»"** e clica **Associar à sala**. A confirmação é obrigatória: o TMDB/JustWatch informa disponibilidade, mas não o link direto para o vídeo. O Dalari Cine **não** adivinha `watchId` a partir do ID do TMDB.
3. A sala seleciona `media.netflix`; os outros participantes veem o link `https://www.netflix.com/watch/<id>`, abrem no próprio navegador/login e clicam **Sincronizar esta aba** (só aceita o mesmo `watchId` da sala). Nenhuma aprovação do Host.
4. Daí em diante play/pause/seek em qualquer aba chegam às demais. Ações causadas pela sala não voltam como eco. Se o navegador bloquear o play automático, **só aquela aba** mostra **Reproduzir aqui**; as outras não são pausadas.
5. Se a aba abrir **outro** `/watch/<id>` (ex.: próximo episódio), ela é desassociada com aviso; a sala mantém o título e a pessoa pode associar o novo episódio de novo (com confirmação).

## Arquitetura e fronteiras

```
aba Dalari Cine (credencial)  ──MessageChannel privado──  room-content.js  ──runtime.connect──┐
  server/netflix-bridge.js     (origem exata)           (mundo isolado)                    ▼
                                                                                       hub.js (service worker)
aba Netflix  ◀── netflix-content.js (mundo isolado) ◀──runtime.connect──────────────────────┘
   <video> + núcleo de sincronização (vendor/)
```

- **Credenciais**: ficam só no JS da página Dalari Cine. A extensão recebe `sanitizeSnapshot` (apenas `code, you, revision, serverTime, status, platform, selectedMatch, media, playback`; nunca voz/SDP, nomes, `viewing`, tokens) e devolve `{titleId, watchId, action, positionSec}`. Testes registram todo o tráfego de portas/janelas e verificam que nenhum token passa.
- **Validação em cada fronteira** (`src/bridge-protocol.js`): versão, chaves exatas, direção, tipos, `watchId` `^[0-9]{1,12}$`, `roomCode` de 6 dígitos, papel, `titleId`, posição 0–86400. O hub confere `sender.id`, `sender.origin`, `frameId === 0`, URL `/watch/<id>` e o nome da porta; limita 400 mensagens/10 s por porta.
- **Associação exclusiva**: uma aba Netflix só fala com uma aba da sala (a que a associou); outra sala do mesmo navegador recebe `already_bound`. Eventos da aba são encaminhados só ao par e só se o `watchId` coincidir; `ack` só vale para eventos reais, uma vez.
- **Sem estado persistente**: o service worker pode ser encerrado; as abas reconectam e a página refaz a associação já confirmada (mesma aba, mesmo `watchId`) sem novo clique. Recarregue a aba Dalari Cine depois de recarregar/atualizar a extensão.
- **Permissões**: `permissions: []`, sem `host_permissions`, sem `tabs`, `storage`, `cookies`, `webRequest`, sem `externally_connectable`. O código não lê cookies, senha, DRM/EME, captura de mídia nem rede (verificado por teste de varredura do código-fonte).
- Mensagens da página usam `targetOrigin` exato (nunca `"*"`) e `event.source === window` + `event.origin === location.origin`.
- `src/vendor/` contém cópias idênticas de `extension-spike/src/video-controller.js` e `netflix-room-sync-core.js` (teste de igualdade evita divergência).

## Limites conhecidos

- A origem Dalari Cine local aceita qualquer servidor em `127.0.0.1`/`localhost`. Um site local malicioso poderia listar os `watchId` abertos e comandar play/pause da aba associada; **não** alcança a credencial da sala nem a conta Netflix. Em produção, restrinja à origem HTTPS do Dalari Cine.
- Selecionar a mídia na sala inicia o estado desejado como "tocando em 0:00" (comportamento do serviço); quem já estava adiantado volta ao início ao sincronizar.
- O player real da Netflix pode disparar eventos de play/pause/seek próprios (buffering, mudança de qualidade) que a página falsa não imita; o filtro de eco foi validado só com eventos de mídia padrão.
- Não há "Ressincronizar" manual nesta etapa; desligar e sincronizar de novo refaz a associação.

## Testes

```
node --test extension-bridge/tests/*.cjs         # protocolo, hub, scripts de conteúdo, manifest, varredura de código
node --test tests/*.mjs                          # serviço, sala de 4, ponte com 4 navegadores simulados
node tools/e2e-netflix-bridge.mjs [capturas]     # Chromium real + extensão carregada (DUOTELA_PEOPLE=2..4)
node tools/e2e-room-4p.mjs [capturas]            # sala de 4 pela interface, voz em malha real
```

Os dois scripts em `tools/` usam o Chromium que já está instalado (`%LOCALAPPDATA%\ms-playwright\chromium-1248`, ou `DUOTELA_CHROMIUM`) via DevTools Protocol, sem instalar dependências.
