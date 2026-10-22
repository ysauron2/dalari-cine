<div align="center">

# Dalari Cine

**Duas telas, uma sessão.** Assista junto com quem está longe: cada pessoa no próprio serviço, com play e pausa sincronizados e conversa por voz.

[![Última versão](https://img.shields.io/github/v/release/ysauron2/dalari-cine?label=vers%C3%A3o&color=ffac8f)](https://github.com/ysauron2/dalari-cine/releases/latest)
[![Instaladores](https://github.com/ysauron2/dalari-cine/actions/workflows/release.yml/badge.svg)](https://github.com/ysauron2/dalari-cine/actions/workflows/release.yml)
[![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-informational)](LICENSE)

[**Baixar a última versão**](https://github.com/ysauron2/dalari-cine/releases/latest) · [Privacidade](PRIVACIDADE.md) · [Avisos de terceiros](THIRD-PARTY-NOTICES.md)

</div>

---

O Dalari Cine é um aplicativo gratuito para Windows e macOS. Ele **não transmite, grava nem retransmite vídeo**: cada pessoa abre o filme no próprio YouTube ou na própria conta da Netflix, e o app mantém todo mundo no mesmo ponto, enquanto vocês conversam por voz.

> **Estado do projeto:** versão inicial (0.x), criada por uma pessoa só e ainda em teste. O que funciona bem e o que ainda não está pronto está em [Limites](#limites-honestos).

## O que ele faz

- **Sala sincronizada.** Play, pausa e posição iguais para todos, no **YouTube** (player embutido) e na **Netflix** (aberta numa janela do app, cada pessoa com a sua conta). **Prime Video e Crunchyroll estão sendo integrados** e chegam nas próximas versões.
- **Conversa por voz** direta entre os aparelhos, criptografada, sem servidor de voz no meio. Inclui:
  - redução automática do volume do filme enquanto alguém fala;
  - indicador de quem está falando e volume separado por pessoa;
  - tecla de **push-to-talk**, inclusive com a Netflix em foco;
  - escolha de microfone e de saída de áudio.
- **Entrar numa sala com um código curto** (`XXXX-XXXX`), de uso único e válido por 15 minutos. Nada de colar links enormes: quem cria a sala gera o código, a outra pessoa digita.
- **Match de títulos.** Para decidir o que assistir: votem em títulos do catálogo (do TMDB, com onde assistir no Brasil) e o app mostra o que combina.
- **Salas de até 4 pessoas** (o uso mais testado é com 2).
- **Reconexão automática:** se a conexão cair (queda de internet, troca de Wi-Fi), a sala volta sozinha, sem gerar outro código.
- **Visual de cinema:** ao dar play, o resto da tela escurece e volta quando você mexe o mouse; o fundo da sala ganha a cor do cartaz do filme; o avatar de quem fala "respira" com o volume da voz.
- **Seus dados ficam salvos:** nome, preferências e escolhas de áudio continuam lá depois de fechar o app e de atualizar, com uma cópia de segurança no seu perfil.
- **Atualização automática**, com aviso e confirmação de assinatura digital antes de instalar.
- **Estatísticas para nerds** (Ctrl+Shift+D, ou no menu): rota da conexão, qualidade e latência da voz, para quem quer ver o que acontece por baixo.

## Instalar

Baixe o instalador na página de [**Releases**](https://github.com/ysauron2/dalari-cine/releases/latest):

| Sistema | Arquivo |
| --- | --- |
| Windows 10/11 | `DalariCine-Setup-<versão>-x64.exe` |
| macOS, Apple Silicon (M1 ou mais novo) | `DalariCine-<versão>-mac-arm64.dmg` |
| macOS, Intel | `DalariCine-<versão>-mac-x64.dmg` |

Não precisa instalar Node, Python nem mais nada. Na primeira abertura o app baixa o módulo de reprodução protegida (Widevine), então precisa de internet.

**Avisos de segurança do sistema (esperados).** O app não tem a assinatura paga da Microsoft nem da Apple, e o sistema avisa na primeira vez:

- **Windows:** no aviso azul "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**. A instalação é só para o seu usuário, sem pedir administrador.
- **macOS:** abra o `.dmg`, arraste o Dalari Cine para Aplicativos e, na primeira vez, vá em **Ajustes do Sistema → Privacidade e Segurança**, role até o aviso e clique em **Abrir Mesmo Assim**.

Para conferir que o arquivo é mesmo desta página, baixe só pelas Releases deste repositório. O app também confere a assinatura das próprias atualizações.

## Como usar com outra pessoa

1. As duas pessoas instalam o Dalari Cine.
2. Quem vai receber cria a sala e gera o **código curto**; manda o código por qualquer app de conversa.
3. A outra pessoa digita o código em "Entrar numa sala", e quem criou aprova a entrada.
4. Escolham a plataforma (YouTube ou Netflix), liguem a voz e comecem. Quem muda play, pausa ou posição, muda para todos.

Não existe conta nem login: a conexão é direta entre os aparelhos. O código curto passa por um serviço público de encontro (ntfy.sh) que só vê texto cifrado.

## Privacidade

- Sem cadastro, sem login, sem anúncios. Nome de exibição, preferências e histórico ficam só no seu computador.
- A voz e o estado da sala vão **direto** entre os aparelhos, criptografados. Não passam por servidor do Dalari Cine, porque não existe um.
- **Estatísticas anônimas são opcionais** e só são enviadas se você aceitar na primeira abertura (dá para mudar em Perfil). O que é enviado, e o que nunca é, está explicado no app e em [PRIVACIDADE.md](PRIVACIDADE.md). Nunca vão nome, o que você assiste, conversas, códigos ou participantes das salas.
- O app não lê sua senha da Netflix: o login acontece na própria página da Netflix, dentro da janela do app.

## Limites honestos

- **Netflix:** só funciona nas versões oficiais, assinadas com a assinatura de conteúdo protegido da Castlabs (VMP). Se você compilar por conta própria sem essa assinatura, a Netflix dá erro `E100`. A sincronização da Netflix ainda está em teste e pode mudar se a Netflix alterar o player; use uma conta sua e respeite os termos do serviço.
- **Prime Video e Crunchyroll** estão sendo integrados ao app. Por enquanto só há catálogo e match (decidir o que assistir), sem reprodução sincronizada.
- **Voz entre redes difíceis** (CGNAT, redes corporativas ou de universidade) pode não conectar: ainda não há servidor TURN embutido.
- **macOS:** o pacote é gerado e verificado automaticamente, mas ainda foi pouco testado num Mac real.
- O instalador não é assinado pela Microsoft/Apple (ver avisos acima).

## Contribuir e relatar problemas

Achou um problema ou tem uma ideia? Abra uma [issue](https://github.com/ysauron2/dalari-cine/issues). Se for um problema de voz ou conexão, ajuda muito anexar o texto de **Estatísticas para nerds** (botão **Copiar relatório**).

## Para quem mantém o projeto

<details>
<summary><b>Rodar e testar em desenvolvimento</b></summary>

```sh
node web/server/index.js          # serviço da sala + interface em http://127.0.0.1:8787
node --test web/tests/*.test.mjs  # testes da interface e do serviço
cd app && npm ci && npm run install:runtime && npm test   # app Electron/ECS
cd stats-worker && node --test test/*.test.mjs            # painel de estatísticas
```

- `web/`: interface e serviço da sala (Node, sem dependências).
- `app/`: aplicativo Electron (Castlabs ECS) que embute o serviço, a Netflix e a interface; scripts de empacotamento em `app/scripts`.
- `stats-worker/`: serviço opcional de estatísticas anônimas (Cloudflare Worker + D1) e o painel do criador; veja `stats-worker/README.md`. Só entra em uso quando `web/stats-config.json` tem uma `url`.

</details>

<details>
<summary><b>Gerar os instaladores no GitHub</b></summary>

O workflow `.github/workflows/release.yml` monta tudo nos servidores do GitHub (Windows, Mac Apple Silicon e Mac Intel) quando uma tag `vX.Y.Z` é enviada:

```sh
git tag v0.3.0
git push origin v0.3.0
```

Segredos necessários em **Settings → Secrets and variables → Actions**:

- `EVS_ACCOUNT_NAME` e `EVS_PASSWD`: conta gratuita EVS da Castlabs (assinatura VMP, necessária para a Netflix; veja `app/README.md`). Sem eles o build sai, mas sem Netflix.
- `UPDATE_SIGNING_KEY`: chave privada (Ed25519) das atualizações automáticas. Sem ela a Release sai sem atualização automática.

</details>

<details>
<summary><b>Atualização automática: como funciona e como configurar</b></summary>

O app consulta `releases/latest/download/latest.json` 20 segundos depois de abrir e a cada 6 horas. Se houver versão maior, avisa; a pessoa decide. No Windows baixa o instalador, confere o SHA-256, abre em modo silencioso e reabre o app novo; no Mac abre o `.dmg`.

Como os instaladores não têm assinatura da Microsoft/Apple, a confiança vem de uma chave Ed25519 do mantenedor: o `latest.json` é assinado no Actions e o app só aceita se a assinatura bater com a chave pública em `app/update-config.json`. O endereço de download é montado pelo app, nunca vem do manifesto.

Configurar uma vez: gere as chaves com `node app/scripts/update-keys.cjs --write <arquivo-fora-do-projeto>` (grava a pública em `app/update-config.json` e a privada no arquivo), cadastre a privada como segredo `UPDATE_SIGNING_KEY` e guarde uma cópia segura: se ela for perdida, os apps instalados não aceitam atualizações de outra chave. O repositório precisa ser **público** para o app ler a Release.

</details>

## Créditos

Criado por **Daniel Didini (Kaizen)** ([@ysauron2](https://github.com/ysauron2)), em homenagem a **Larissa B.**, que o incentivou a transformar a ideia em app. O nome *Dalari* junta Daniel e Larissa. Em **Perfil → Sobre e créditos** há um botão **♥ Ver a homenagem**, que abre uma pequena animação em 3D.

Feito com [Electron for Content Security (Castlabs)](https://github.com/castlabs/electron-releases), Widevine (Google), [TMDB](https://www.themoviedb.org) (catálogo), [ntfy.sh](https://ntfy.sh) (código curto) e Cloudflare (estatísticas opcionais). Os componentes de terceiros têm licenças próprias: veja [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

*This product uses the TMDB API but is not endorsed or certified by TMDB.* O Dalari Cine não é afiliado, patrocinado nem aprovado pela Netflix, pelo YouTube ou pelo TMDB; esses nomes são marcas dos seus donos.

## Licença

O código é licenciado sob a **MIT** ([LICENSE](LICENSE)). O nome e o ícone "Dalari Cine" e os componentes de terceiros não estão incluídos nessa licença.
