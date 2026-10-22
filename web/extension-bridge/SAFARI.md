# Safari — o que NÃO funciona ainda e por quê

**Nada aqui foi testado em Safari ou em Mac.** A ponte Netflix desta pasta está marcada como **Chrome/Edge experimental**. Este arquivo registra os bloqueios exatos e o menor caminho gratuito a validar num Mac.

## Fatos verificados em fontes oficiais (consultadas em 2026-10-17)

- Netflix lista Safari 14+ (macOS) entre os navegadores suportados: <https://help.netflix.com/en/node/30081>. Isso é sobre **assistir**, não sobre a nossa extensão.
- Extensão Safari **não assinada** é só para teste: "Safari ignora extensões não assinadas por padrão"; é preciso ligar *Allow unsigned extensions* (Safari 17+: Ajustes ▸ Desenvolvedor), e "a configuração **reinicia quando você fecha o Safari**"; uma extensão temporária ("Add Temporary Extension…") some "após 24 horas ou quando você fecha o Safari": <https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension>.
- Distribuição estável de **nossa** extensão exige assinatura e o Apple Developer Program (App Store ou Developer ID + notarização): <https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension>. Decisão do produto: o usuário não pagará a Apple. **Portanto não existe, hoje, instalação simples e permanente da nossa extensão no Safari.**

## Bloqueios técnicos para a ponte segura no Safari

1. **Extensão própria**: só com Xcode (`safari-web-extension-converter`, em Mac) e, para ficar instalada, assinatura paga. Teste sem assinar precisa ser religado a cada abertura do Safari. (Não tentamos converter: não há Mac aqui.)
2. **Userscripts (app gratuito de terceiros)** poderia hospedar um único script com `@match` na origem Dalari Cine e em `netflix.com`, trocando mensagens por armazenamento compartilhado. Isso **não é demonstrável** com o que a documentação do app diz: o README do projeto (<https://github.com/quoid/userscripts>) documenta `GM.setValue/getValue` e `GM.xmlHttpRequest`, mas **não** diz se o armazenamento é compartilhado entre origens do mesmo script, nem documenta `GM_addValueChangeListener` (seria preciso *polling*). Sem teste no Mac não dá para afirmar que a credencial ficaria fora do contexto da Netflix nem que as duas partes se enxergam.
3. **Não** vamos "resolver" isso aceitando `netflix.com` como origem do serviço de sala para um userscript falar com a API por CORS: isso colocaria a credencial no contexto da Netflix, que o desenho proíbe.
4. O código da ponte (`bridge-protocol.js`, `hub.js`, `room-content.js`, `netflix-content.js`) usa só APIs de WebExtension padrão (`runtime.connect`, content scripts, service worker MV3) e é portável em princípio; **não verificamos** o suporte a service worker de fundo/portas no Safari alvo. É a primeira coisa a testar.

## Teste grátis proposto (a executar por alguém com Mac) — sem afirmar que funciona

1. No Mac: `xcrun safari-web-extension-converter extension-bridge --macos-only --no-open` e abrir o projeto no Xcode com a equipe "Personal Team" (conta gratuita, só para desenvolvimento local).
2. Safari ▸ Ajustes ▸ Avançado ▸ mostrar recursos para desenvolvedores; Ajustes ▸ Desenvolvedor ▸ **Permitir extensões não assinadas**; ativar a extensão em Extensões e **permitir acesso** a `127.0.0.1` e `www.netflix.com`.
3. Repetir o roteiro do `README.md` com um segundo navegador (Chrome/Edge) como Host. Anotar: o handshake detecta a extensão? a aba Netflix aparece na lista? o `play()` é bloqueado (esperado sem gesto) e "Reproduzir aqui" funciona?
4. Lembrar: ao fechar o Safari, reativar "Permitir extensões não assinadas" e a extensão. Se isso for inaceitável, a Etapa 2 no Safari fica **bloqueada** até haver uma rota assinada ou uma alternativa validada.
