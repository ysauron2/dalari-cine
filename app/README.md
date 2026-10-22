# Dalari Cine + Netflix na mesma janela — experimento isolado

Para o caminho de teste privado no Mac sem assinatura Apple, veja [MACOS-TESTE.md](MACOS-TESTE.md). Ainda não há pacote macOS validado nem sala entre casas.

O Dalari Cine abre em tela inteira. Os atalhos **YouTube** e **Netflix** na página inicial preparam a criação ou entrada na sala. Quando uma sala ativa escolhe Netflix, o site oficial aparece na mesma janela e o botão **Abrir sala** mostra os controles do Dalari Cine por cima. YouTube permanece no player da sala, sem vista da Netflix. Cada área usa seu próprio `WebContentsView`. Usa Electron for Content Security (ECS) da Castlabs com Widevine. A versão principal do Dalari Cine continua independente deste experimento.

## Executar no Windows

Requer Node.js compatível com o ECS e acesso à internet para instalar o binário. Nesta pasta:

```powershell
npm ci --cache .npm-cache
npm run install:runtime
npm test
npm run check
```

Em outro terminal, na pasta `web/` do repositório, inicie `node server/index.js` (porta padrão `8787`). Depois, nesta pasta:

```powershell
$env:DUOTELA_URL = 'http://127.0.0.1:8787/'
npm start
```

Sem `DUOTELA_URL`, a janela mostra instruções. O app aceita somente `127.0.0.1` ou `localhost` para o Dalari Cine, **a menos que você ative a rede privada**: com `DUOTELA_ALLOW_LAN=1` (ou, no macOS, o arquivo `duotela-allow-lan.txt` com `1` no perfil), `DUOTELA_URL` pode ser um IPv4 privado como `http://192.168.0.181:8798/`. Nesse modo o Chromium trata essa origem exata como segura só para liberar o microfone; é HTTP sem criptografia, então use em rede de confiança. O servidor precisa de `HOST`, `ALLOW_NON_LOOPBACK=1` e `ALLOWED_ORIGINS` com essa origem (veja [MACOS-TESTE.md](MACOS-TESTE.md)).

**Pela internet:** com `DUOTELA_ALLOW_REMOTE=1` (ou o arquivo `duotela-allow-remote.txt` com `1` no perfil) `DUOTELA_URL` pode ser `https://seu-servidor/`. Só HTTPS, sem credenciais na URL. O app passa a carregar e dar acesso ao microfone a esse servidor: aponte apenas para um servidor seu ou de confiança. Voz entre redes também exige STUN/TURN no servidor (veja `web/server/README.md`). A Netflix fica em uma partição persistente e separada: o login feito pelo usuário permanece no perfil local entre aberturas, até a Netflix expirar a sessão ou o usuário apagar os dados. Nenhum login é automatizado, e o app não lê credenciais, cookies nem conteúdo de vídeo. O arquivo `.gitignore` exclui runtime, cache e perfil local. Não publique essas pastas. A mudança da partição temporária para a persistente pode exigir um último login após esta atualização.

## Estado do teste

No Windows local, em 20/10/2026, ECS `44.5.1+wvcus` abriu as duas áreas; os logs registraram `page_loaded` para `127.0.0.1` e `www.netflix.com`, e `components_ready` para Widevine `4.10.3112.0`. Após assinatura para `streaming`, o usuário relatou em 21/10 que a reprodução aparentemente funcionou. Veja [REPORT.md](REPORT.md).

## Próxima prova decisiva

O primeiro teste real retornou **E100**. O verificador EVS confirmou que o executável tinha apenas certificado VMP de desenvolvimento. Em 21/10/2026, o executável local foi assinado para `streaming` e `verify-pkg` confirmou a assinatura válida. Depois disso, o usuário relatou reprodução aparentemente funcional; falta uma prova contínua com áudio. **Quem baixa um pacote já assinado não precisa ter conta EVS**. Quem recompila ou modifica o executável deve assinar o próprio pacote. A [documentação da Castlabs](https://github.com/castlabs/electron-releases/wiki/EVS) descreve o processo.

Para preparar outro build, se ainda não tiver conta EVS, abra você mesmo um PowerShell nesta pasta e execute:

```powershell
.\.evs-venv\Scripts\python.exe -m castlabs_evs.account signup
```

Se você já tem conta EVS, use `reauth` no lugar de `signup`. Preencha os dados e o código de e-mail somente no terminal. Depois de concluir, feche a janela experimental do Electron e execute `./scripts/sign-vmp-windows.ps1` nesta pasta. O script assina o ECS para streaming e verifica o resultado. Não coloque usuário, senha ou código de confirmação no chat nem em arquivos do projeto.

Depois, entre na própria Netflix na área direita e tente reproduzir um título por 2 a 3 minutos. Registre somente sucesso/erro, código de erro e qualidade percebida. Não registre senha, cookies nem vídeo. Um teste positivo no Windows ainda precisa ser repetido no Mac real antes da integração ou distribuição.

## Atualização automática

Código em `src/updater.cjs` (testes em `tests/updater.test.cjs` e `tests/update-manifest.test.cjs`). A configuração e o passo a passo estão no `README.md` da raiz, seção "Atualização automática". Em desenvolvimento (`npm start`) o verificador não roda sozinho; só com o app empacotado.

## Sala sincronizada (teste em andamento)

Após o match, abra o filme ou episódio exato na área Netflix e confirme uma vez o `/watch/ID` no painel da sala. O Dalari Cine envia o mesmo link aos participantes e a ponte experimental observa o vídeo visível para compartilhar play, pausa e posição. Não há nova aprovação a cada ação. Cada pessoa escolhe idioma do áudio, legendas e volume no próprio player da Netflix; esses ajustes não são transmitidos. A conversa por voz usa o botão **Ligar voz** e volume separado no painel. O Electron permite microfone apenas à origem local do Dalari Cine e rejeita câmera e captura de tela.

Esta ponte passou em teste automatizado com um player simulado, mas ainda precisa ser validada com Netflix autenticada em duas janelas e depois em dois computadores. A Netflix pode bloquear autoplay ou alterar o player; nesse caso a sala mostra uma mensagem para usar o botão Reproduzir no player local. O microfone e a voz por redes diferentes também precisam de teste real; sem TURN, algumas redes podem não conectar.
