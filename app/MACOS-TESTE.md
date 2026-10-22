# Dalari Cine no macOS: pacote privado sem assinatura Apple

Este é um roteiro de **construção e teste no Mac**, não uma versão macOS validada. A pessoa que receber o aplicativo só precisará abrir `Dalari Cine.app` e, na primeira vez, autorizar a abertura manualmente no macOS. Ela não precisa de conta EVS; a assinatura VMP fica no pacote preparado por quem o constrói.

## Preparar o pacote no Mac

Baixe o repositório inteiro (as pastas `app/` e `web/`). Se preferir não esperar o GitHub gerar o `.dmg` (veja o README da raiz), no Terminal do Mac entre em `app/` e execute:

```sh
npm ci --cache .npm-cache
npm run install:runtime
python3 -m venv .evs-venv
.evs-venv/bin/python -m pip install castlabs-evs
./scripts/build-macos-app.sh
./scripts/sign-macos-app.sh
```

O último comando pede a autenticação da conta EVS **no próprio Terminal** para assinar o runtime Castlabs para streaming. Não coloque senha, códigos, tokens ou a pasta `.evs-venv` no repositório. O script confere se o binário ECS corresponde à arquitetura do Mac (`arm64` ou `x86_64`), verifica a assinatura VMP e aplica uma assinatura local ad hoc do macOS. Isso **não** equivale a Developer ID nem a notarização Apple. O resultado fica em `dist-macos/Dalari Cine.app`.

O pacote contém a interface e o serviço local, que inicia automaticamente em `127.0.0.1` em uma porta livre. O perfil persistente da Netflix fica em `~/Library/Application Support/Dalari Cine`, fora do `.app`. Não apague essa pasta ao atualizar o aplicativo se quiser manter a sessão Netflix. O código não coleta a senha da Netflix; o login é feito no site oficial dentro da janela.

## Primeiro teste

1. Abra `Dalari Cine.app` no Mac. Se o Gatekeeper impedir a primeira abertura, use a opção **Abrir Mesmo Assim** em **Ajustes do Sistema → Privacidade e Segurança**. Faça isso somente com o pacote que você recebeu de uma origem confiável.
2. Confira se aparece o dashboard, se é possível criar uma sala local e se o atalho Netflix abre a vista integrada quando a sala escolhe Netflix.
3. Entre na Netflix manualmente e reproduza um título por alguns minutos. Verifique vídeo, áudio e eventuais erros. Teste play, pausa e avanço no mesmo Mac.
4. Feche e reabra o aplicativo. Verifique se o login continua válido. A Netflix ainda pode pedir novo login conforme suas próprias políticas.

Não envie senha, código de acesso, cookie ou gravação do vídeo nos relatos. Um relato útil contém apenas modelo/arquitetura do Mac, versão do macOS, se abriu, se vídeo e áudio tocaram, duração aproximada e código de erro se houver.

## Conectar o Mac ao servidor Dalari Cine do Windows na mesma rede (opt-in)

Por padrão o `.app` só aceita um Dalari Cine em `127.0.0.1`. Para usar o servidor de outro computador na **rede privada** (10.x, 172.16-31.x ou 192.168.x), crie dois arquivos na pasta do perfil, `~/Library/Application Support/Dalari Cine/`:

```sh
mkdir -p "$HOME/Library/Application Support/Dalari Cine"
printf 'http://192.168.0.181:8798/' > "$HOME/Library/Application Support/Dalari Cine/duotela-url.txt"
printf '1' > "$HOME/Library/Application Support/Dalari Cine/duotela-allow-lan.txt"
```

Troque o IP e a porta pelos do servidor. Reabra o aplicativo. Para voltar ao modo local, apague os dois arquivos. Sem `duotela-allow-lan.txt` com `1`, a URL de rede é recusada.

O que a opção muda: aceita **somente** a origem exata informada (IPv4 privado, HTTP, sem credenciais) e a trata como segura **apenas para liberar o microfone** (o Chromium recusa microfone em HTTP). Navegação, isolamento, TLS, DRM e permissões da Netflix não mudam. HTTP na LAN não tem criptografia: use só em rede de confiança.

No servidor (Windows), ele precisa escutar na rede e aceitar essa origem, por exemplo: `HOST=192.168.0.181 PORT=8798 ALLOW_NON_LOOPBACK=1 ALLOWED_ORIGINS=http://192.168.0.181:8798 node server/index.js`. O firewall deve permitir a porta. **Não testado no Mac**; o macOS pode pedir permissão de "Rede Local" na primeira conexão.

## Conectar o Mac a um servidor na internet (HTTPS, opt-in)

Crie `duotela-url.txt` com `https://seu-servidor/` e `duotela-allow-remote.txt` com `1` na mesma pasta do perfil. O app aceita só HTTPS (sem usuário, senha ou parâmetros na URL) e passa a dar ao servidor o acesso ao microfone; use apenas servidor seu ou de confiança. A voz entre casas precisa de STUN/TURN no servidor. Não testado no Mac.

## Limites deste pacote

- Sem a opção acima, a sala que inicia dentro do `.app` escuta **somente no próprio Mac**. Isso permite testar a interface e a Netflix localmente, mas **não conecta o Mac à sala do Windows**.
- Play e pausa da Netflix foram testados com um vídeo simulado. Ainda falta testar a Netflix real em duas máquinas, depois a voz e a precisão de sincronização entre redes.
- Nenhum `.app` macOS foi produzido ou executado nesta máquina Windows. O pacote e a assinatura precisam ser montados e conferidos em um Mac real antes de enviá-lo à Larissa.
- Para distribuição pública sem o aviso manual do macOS, será necessário avaliar Developer ID e notarização. O teste privado acima não depende de pagamento à Apple.
