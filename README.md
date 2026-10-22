# Dalari Cine

Duas telas, uma sessão: assista juntos, cada pessoa no próprio serviço (YouTube, Netflix), com play e pausa sincronizados e conversa por voz. O Dalari Cine não captura nem retransmite o vídeo e não lê sua senha de nenhum serviço.

## Instalar (usuários)

Baixe o instalador da versão mais recente em **Releases**:

- **Windows:** `DalariCine-Setup-<versão>-x64.exe`. Instala só para o seu usuário, sem pedir administrador. O Windows pode mostrar o aviso "O Windows protegeu o computador" (SmartScreen): clique em **Mais informações → Executar assim mesmo**. O instalador não tem assinatura paga de editor.
- **macOS:** `Dalari Cine-<versão>-mac-arm64.dmg` (Apple Silicon: M1 ou mais novo) ou `-mac-x64.dmg` (Intel). Abra o `.dmg` e arraste o Dalari Cine para Aplicativos. Na primeira vez o macOS avisa que o app não é de um desenvolvedor identificado: vá em **Ajustes do Sistema → Privacidade e Segurança**, role até o aviso e clique em **Abrir Mesmo Assim**.

Não precisa instalar Node, Python nem nada mais. Na primeira abertura o app baixa o módulo de reprodução protegida (Widevine), então precisa de internet.

### Como usar com outra pessoa

Não há servidor para manter: os dois aparelhos se conectam direto. O Host cria a sala, gera o **convite de conexão direta** e manda o código por qualquer app de conversa; o convidado cola o código, devolve a resposta, e o Host cola a resposta e aprova. Detalhes em `web/server/README.md` (seção "Conexão direta sem servidor"). Redes que bloqueiam conexão direta (CGNAT, redes corporativas) podem não conectar a voz; isso ainda não tem solução embutida (falta TURN).

## Para quem mantém o projeto: gerar os instaladores no GitHub

O workflow `.github/workflows/release.yml` monta tudo sozinho nos servidores do GitHub (Windows, Mac Apple Silicon e Mac Intel), sem nada instalado na sua máquina.

1. **Cadastre os segredos da Netflix (uma vez).** A Netflix só toca com o app assinado pela Castlabs (VMP/EVS). Crie sua conta gratuita EVS (veja `app/README.md`, a seção da assinatura) e, no GitHub, em **Settings → Secrets and variables → Actions**, crie `EVS_ACCOUNT_NAME` e `EVS_PASSWD`. Quem baixa o instalador **não** precisa de conta EVS. Sem esses segredos o build continua, mas o app sai sem VMP: YouTube funciona, Netflix dá erro E100. Os tokens EVS expiram em cerca de um mês; o workflow refaz o login a cada execução com o usuário e a senha.
2. **Publique uma versão:**
   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```
   O workflow roda os testes, gera os três instaladores e cria a Release com os arquivos. Também dá para rodar manualmente em **Actions → Instaladores Dalari Cine → Run workflow**; nesse caso os arquivos ficam como artefatos da execução, sem Release.

### Atualização automática

O app consulta a última Release (`https://github.com/<dono>/<repo>/releases/latest/download/latest.json`) 20 segundos depois de abrir e a cada 6 horas. Se houver versão maior, mostra um aviso; a pessoa decide. No Windows, o app baixa o instalador, confere o SHA-256, abre-o em modo silencioso (`/S`), fecha, e o instalador abre a versão nova. No Mac, abre o `.dmg` para arrastar.

Segurança: os instaladores não têm assinatura da Microsoft/Apple, então a confiança vem de uma chave **Ed25519** sua. O `latest.json` (versão + SHA-256 + tamanho de cada instalador) é assinado no GitHub Actions e o app só aceita se a assinatura bater com a chave pública gravada em `app/update-config.json`. O endereço de download é montado pelo próprio app (nunca vem do manifesto) e o nome do arquivo é validado.

Configurar (uma vez):

1. No PowerShell, em `app`: `node scripts/update-keys.cjs`. Ele imprime uma chave pública e uma privada.
2. Cole a **pública** em `app/update-config.json` (`publicKey`) e faça o commit. O campo `repo` é preenchido sozinho no build com o repositório do GitHub Actions.
3. Guarde a **privada** no GitHub: Settings → Secrets and variables → Actions → New repository secret, nome `UPDATE_SIGNING_KEY`. Não a salve em arquivo do projeto nem a envie a ninguém: quem a tiver publica atualizações que todos os apps aceitam.
4. As tags precisam ser `vX.Y.Z` (por exemplo `v0.2.0`). Builds sem tag (`0.0.0-dev`) nunca se atualizam.
5. **O repositório precisa ser público** (ou os arquivos da Release precisam estar em outro endereço público), porque o app lê a Release sem login. Com repositório privado a consulta recebe 404 e o app simplesmente não encontra atualização.

Sem chave pública ou sem o segredo, nada quebra: a atualização automática fica desligada (a Release sai sem `latest.json`).

### Créditos

Criado por **Daniel Didini (Kaizen)** — [github.com/ysauron2](https://github.com/ysauron2) — em homenagem a **Larissa B.**, que o incentivou. O mesmo texto aparece no app em Perfil → Sobre e créditos.

### Estado e limites honestos

- Este pipeline **ainda não foi executado no GitHub**. Localmente foram verificados: os testes, a montagem da pasta do app no Windows e a abertura do `DalariCine.exe` montado (o serviço interno sobe, a interface carrega e o Widevine fica pronto). **Não verificados:** o instalador NSIS, os jobs de macOS, a assinatura VMP em CI (a autenticação não interativa do `reauth` por variáveis de ambiente segue a documentação da Castlabs, mas não foi testada) e o resultado da Netflix com o pacote assinado pelo CI.
- Os rótulos de runner do macOS (`macos-15`, `macos-15-intel`) podem precisar de ajuste se o GitHub os renomear.
- **Atualização automática** (veja a seção abaixo): escrita e testada com arquivos e rede simulados; **não** foi executada de ponta a ponta com uma Release real, e o instalador NSIS não foi compilado nesta máquina. No Mac ela baixa, confere e abre o `.dmg`, mas arrastar para Aplicativos continua manual.
- macOS sem assinatura Apple Developer (paga) sempre mostra o aviso de primeira abertura. Para eliminá-lo seria preciso Developer ID e notarização.
- **Licença:** MIT para o código (`LICENSE`); o nome e o ícone "Dalari Cine" e os componentes de terceiros não estão incluídos (`THIRD-PARTY-NOTICES.md`). Uma busca na web não achou nenhum produto ou marca chamado "Dalari Cine", mas isso **não** substitui uma busca oficial em INPI (Brasil), EUIPO e USPTO antes de divulgar amplamente. Existem marcas "Duo" de outras empresas (por exemplo, o Duo da Cisco), então vale uma conferência profissional.
- **Privacidade:** veja `PRIVACIDADE.md` (a mesma política mostrada no app, na primeira abertura e em Perfil).
- **Termos de terceiros:** leia os termos da conta EVS da Castlabs e da Netflix antes de distribuir publicamente; este projeto não é afiliado à Netflix.
- O catálogo local (`web/data`) vem de uma consulta ao TMDB; mantenha a atribuição exigida pelo TMDB.

## Desenvolvimento

```sh
node web/server/index.js          # serviço da sala + interface em http://127.0.0.1:8787
node --test web/tests/*.test.mjs  # testes da interface e do serviço
cd app && npm ci && npm run install:runtime && npm test   # app Electron/ECS
```

- `web/`: interface e serviço da sala (Node sem dependências).
- `stats-worker/`: serviço opcional de estatísticas anônimas (Cloudflare Worker + D1) e o painel do criador; veja `stats-worker/README.md`. Só entra em uso quando `web/stats-config.json` tem uma `url`.
- `app/`: aplicativo Electron (Castlabs ECS) que embute o serviço, a Netflix e a interface; scripts de empacotamento em `app/scripts`.
