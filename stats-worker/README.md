# Estatísticas anônimas do Dalari Cine (Cloudflare Worker + D1)

Um serviço pequeno, só seu: recebe avisos anônimos do app (só de quem permitiu), guarda contagens num banco D1 e mostra tudo num painel protegido por senha.

- `POST /v1/ping`: o app avisa (a cada 2 minutos com o app aberto e a cada evento).
- `GET /`: o painel. `GET /api/summary` e `GET /api/export.csv`: os dados do painel e a planilha.
- Guarda: um número aleatório por instalação, versão, sistema, estado (parado/em sala/em chamada) e contadores por dia. **Não guarda** IP, nome, o que a pessoa assiste, conversas nem códigos de sala. O Worker aceita só o formato exato do aviso (veja `validatePing` em `src/index.js`).
- Desenhado para ~1 escrita de linha por aviso, para caber folgado no plano gratuito do D1 (limites atuais em <https://developers.cloudflare.com/d1/platform/pricing/>; confira antes de contar com eles para muita gente).

## Publicar (uma vez)

Precisa de Node 24 e da sua conta Cloudflare. No PowerShell, nesta pasta (`stats-worker`):

```powershell
npx wrangler login
```
```powershell
npx wrangler d1 create dalari-stats
```
O comando mostra um `database_id`. Cole-o em `wrangler.toml` (campo `database_id`). Depois crie as tabelas e a senha do painel (o segredo é digitado num prompt oculto, nunca vai para arquivo):

```powershell
npx wrangler d1 execute dalari-stats --remote --file=schema.sql
```
```powershell
npx wrangler deploy
```
O `deploy` mostra o endereço, algo como `https://dalari-stats.SEU-USUARIO.workers.dev`. Só então defina a senha do painel (o segredo é digitado num prompt oculto, nunca vai para arquivo):
```powershell
npx wrangler secret put PANEL_PASSWORD
```

## Ligar o app ao serviço

Coloque o endereço em `web/stats-config.json` (campo `url`, sem barra no fim), faça o commit e publique uma versão:

```json
{ "url": "https://dalari-stats.SEU-USUARIO.workers.dev", "version": "dev" }
```
O campo `version` é preenchido sozinho com a versão da tag no empacotamento. Sem `url`, o app não pergunta nem envia nada. Com `url`, o app pergunta na primeira abertura e a pessoa decide; quem recusa não cria identificador nem envia nada.

## Ver as estatísticas

Abra o endereço do Worker no navegador. Ele pede uma senha: o usuário pode ser qualquer um, a senha é a que você definiu em `PANEL_PASSWORD`. O painel mostra pessoas com o app aberto/em sala/em chamada agora, ativas por dia/semana/mês, instalações novas, salas e chamadas por dia, falhas e rota da voz, e versões/sistemas. **Baixar planilha** exporta tudo em CSV.

Para proteger com login em vez de senha (e-mail ou Google), você pode pôr o Worker atrás do Cloudflare Access; confira os limites do plano gratuito.

## Alertas e resumo no Telegram (opcional)

O Worker confere os contadores de hoje a cada 30 minutos e avisa você no Telegram se algo estiver falhando muito (pareamento, voz, qualidade ruim ou muitos erros do app), no máximo uma vez por tipo a cada 6 horas. Toda segunda-feira, às 12:00 UTC (09:00 em Brasília), manda um resumo da semana. Usa só contadores agregados: nada que identifique alguém.

1. No Telegram, procure **@BotFather**, mande `/newbot`, escolha um nome e guarde o **token** que ele devolve (é como uma senha: não o publique).
2. Abra uma conversa com o seu bot novo e mande qualquer mensagem (por exemplo "oi").
3. Descubra o seu **chat id**: no navegador, abra `https://api.telegram.org/bot<SEU_TOKEN>/getUpdates` (troque `<SEU_TOKEN>`) e procure `"chat":{"id":` seguido de um número. Esse número é o chat id.
4. Cadastre os dois como segredos (o valor é digitado num campo oculto):

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
```
```powershell
npx wrangler secret put TELEGRAM_CHAT_ID
```
5. Atualize o banco e publique de novo (a tabela `alerts` e o agendamento são novos):

```powershell
npx wrangler d1 execute dalari-stats --remote --file=schema.sql
```
```powershell
npx wrangler deploy
```
6. Abra o painel e clique em **Testar Telegram**: uma mensagem de teste deve chegar no seu Telegram. Se aparecer "Telegram não configurado", falta um dos dois segredos.

### Comandos: perguntar ao bot na hora

Com mais um passo, você manda um comando ao seu bot e ele responde com os números do painel:

As respostas são feitas para **leitura rápida**: o veredito vem primeiro (🟢 tudo certo, 🟡 atenção, 🔴 problema), as frases são curtas, os nomes vêm em português (nada de códigos internos), e no fim há uma linha **"O que fazer"**. Além dos comandos, o bot deixa **botões fixos no teclado do Telegram**: é só tocar, sem digitar. Comece sempre por **🚦 Está tudo bem?**.

| Botão | Comando | Resposta |
| --- | --- | --- |
| 🚦 Está tudo bem? | `/status` | um veredito (verde, amarelo ou vermelho) com os pontos que merecem atenção e até 3 coisas a fazer |
| 👥 Agora | `/agora` | quantas pessoas estão com o app aberto neste momento (últimos 5 min), em sala e em chamada, mais o resumo de hoje |
| 📅 Hoje | `/hoje` | o que aconteceu hoje, agrupado (uso, pareamento, voz, erros) |
| 🗓 Semana | `/semana` | o resumo dos últimos 7 dias |
| 🚨 Erros | `/erros` | cada tipo de erro do app, quantas vezes e o que significa |
| ☁️ Cloudflare | `/cloudflare` | uso da conta Cloudflare em barras, em relação ao limite grátis |
| 📦 Versões | `/versoes` | quantas pessoas estão em cada versão do app |
| ❓ Ajuda | `/ajuda` | como usar |

Palavras simples também funcionam sem a barra ("agora", "erros", "tudo bem"). O menu que aparece ao digitar `/` é configurado uma vez com a API do Telegram (`setMyCommands`); se um dia você trocar de bot, é preciso refazer.

O bot só responde ao **seu** chat (`TELEGRAM_CHAT_ID`) e só a mensagens que trazem um segredo que o Telegram repete a cada envio; qualquer outra pessoa ou chamada é ignorada.

1. Crie um segredo aleatório (só letras e números) no PowerShell e copie o resultado:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
```
2. Cadastre-o e publique de novo:

```powershell
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```
```powershell
npx wrangler deploy
```
3. Diga ao Telegram para enviar as suas mensagens ao Worker (troque `<SEU_TOKEN>` e `<O_SEGREDO>`; o token aparece na tela só desta vez, no seu computador):

```powershell
curl.exe -s "https://api.telegram.org/bot<SEU_TOKEN>/setWebhook" -d "url=https://dalari-stats.dalaricine.workers.dev/v1/telegram" -d "secret_token=<O_SEGREDO>"
```
Deve responder `{"ok":true,"result":true,"description":"Webhook was set"}`.
4. No Telegram, mande `/agora` para o seu bot.

### Dados da sua conta Cloudflare no Telegram (`/cloudflare`)

O bot roda dentro do próprio Worker, na Cloudflare: não é instalado no computador de ninguém. Com um token de **leitura** da Cloudflare ele também consulta o uso da sua conta e responde com `/cloudflare` (também `/infra` e `/limites`):

- requisições dos Workers hoje, em relação ao limite grátis de 100.000 por dia, com erros e tempo de CPU (o limite grátis é 10 ms por requisição);
- uso do D1 hoje: consultas, linhas lidas (limite grátis de 5 milhões por dia) e gravadas (100.000 por dia);
- tamanho do banco (limite grátis de 5 GB).

Os dias zeram à meia-noite UTC (21h em Brasília). E, a cada 30 minutos, o bot **avisa sozinho quando qualquer um desses números passar de 70% do limite grátis**, antes de o painel parar de funcionar.

1. No painel da Cloudflare: **Meu perfil → Tokens de API → Criar token → Criar token personalizado**. Em **Permissões** escolha **Conta → Análises da conta (Account Analytics) → Leitura (Read)**; em **Recursos da conta**, a sua conta. Crie e copie o token (aparece uma vez só).
2. Copie o **ID da conta**: é o número longo (32 letras e números) que aparece na barra de endereço depois de `dash.cloudflare.com/`, ou na página inicial de Workers e Pages.
3. Cadastre os dois (o valor é digitado num campo oculto) e publique de novo:

```powershell
npx wrangler secret put CF_API_TOKEN
```
```powershell
npx wrangler secret put CF_ACCOUNT_ID
```
```powershell
npx wrangler deploy
```
4. No Telegram, mande `/cloudflare` ao seu bot. Se o token estiver sem a permissão certa, o próprio bot diz "token sem permissão"; se um número específico não existir na API (a Cloudflare muda os campos de vez em quando), aquela linha aparece como "indisponível" e as outras continuam.

O ID do banco D1 já está no `wrangler.toml` (variável `D1_DATABASE_ID`); só o token e o ID da conta ficam como segredos.

Regras de alerta (em `src/alerts.js`): pareamento com 40% ou mais de falhas (mínimo 5 tentativas), voz com 40% ou mais de falhas (ou 8 falhas), qualidade ruim em 40% ou mais das chamadas medidas (mínimo 5), ou 10 erros do app no dia (ou 5 do mesmo tipo). Os limites ficam no código e podem ser ajustados.

## Avisos de novidade, resumo do dia e feedback (Telegram)

Usam o mesmo bot. Nada disso identifica ninguém: o id da instalação nunca aparece nas mensagens.

| O quê | Quando chega |
| --- | --- |
| 🆕 Nova instalação | Quando um id novo aparece (no máximo 10 avisos por dia; o resto entra só no resumo) |
| 📦 Primeira pessoa na versão X | Quando a primeira instalação reporta uma versão nunca vista (diz se foi atualização e de qual versão) |
| 🌙 Resumo do dia | Todo dia às 22h de Brasília (cron `0 1 * * *`, UTC): veredito, pessoas, salas, chamadas, pareamento e erros |
| 💬 Feedback | Na hora em que alguém clica em Enviar em Perfil → Falar com o criador |

Depois de atualizar, rode de novo o `schema.sql` (é seguro repetir; ele marca como "já vistas" as versões que já estavam em uso, para não avisar por elas) e faça o deploy:

```powershell
npx wrangler d1 execute dalari-stats --remote --file=schema.sql
npx wrangler deploy
```

**Feedback (`POST /v1/feedback`)**: o app manda tipo, texto (3 a 1000 caracteres), contato opcional e, se a pessoa deixar marcado, versão e sistema. O Worker valida com formato fechado, escapa todo o texto antes de mandar ao Telegram e **não guarda o texto nem o contato** (só um contador diário). Limites: 3 mensagens por hora por IP e 60 por dia no total (429); sem Telegram configurado responde 503. Erros do Telegram viram 502 e o app mantém o texto na tela para tentar de novo.

## Catálogo de títulos (TMDB)

O Worker monta o catálogo que o Início e o Descobrir mostram (cartaz, onde assistir no Brasil, **duração** e **trailer**) e o entrega ao app em `GET /v1/catalog`. O token do TMDB fica **só aqui**, como segredo: nunca vai para o PC das pessoas.

1. No TMDB (Configurações → API), copie o **"Token de Leitura da API"** (o comprido, que começa com `eyJ`). **Não** é a "Chave da API" curta.
2. Guarde como segredo (a digitação fica oculta):

```powershell
npx wrangler secret put TMDB_READ_ACCESS_TOKEN
```

3. Crie as tabelas novas (é seguro repetir) e publique:

```powershell
npx wrangler d1 execute dalari-stats --remote --file=schema.sql
npx wrangler deploy
```

Como funciona: a cada 30 minutos o Worker confere se o catálogo está em dia. O plano grátis da Cloudflare só permite cerca de 50 chamadas externas por execução, então os detalhes de cada título (duração, trailer, onde assistir) são buscados aos poucos e guardados; em 2 ou 3 rodadas o catálogo de 60 títulos fica completo, e depois é renovado uma vez por dia (detalhes com mais de 7 dias são refeitos). Só entram títulos com **assinatura ou grátis confirmados no Brasil**. Se o catálogo ficar parado por mais de 2 dias, o resumo do dia no Telegram avisa.

## Retransmissor TURN (conexão entre redes difíceis)

O Worker entrega ao app **credenciais temporárias** do Cloudflare Realtime TURN em `GET /v1/ice`. O app só usa o retransmissor quando a conexão direta entre as duas pessoas não abre (redes que bloqueiam, CGNAT); os dados continuam cifrados.

1. No painel da Cloudflare: **Realtime → TURN Server → Create**. Anote o **Turn Token ID** e o **API Token** (só aparece uma vez).
2. Guarde os dois como segredos (a digitação fica oculta):

```powershell
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

3. Publique: `npx wrangler deploy`.

Custo e proteção: a Cloudflare cobra o tráfego que **sai** do TURN (1 000 GB grátis; depois US$ 0,05/GB). As credenciais valem 4 horas, cada endereço pode pedir no máximo 30 por hora e o Worker emite no máximo 3 000 por dia (contador `ice_issued`). O token da chave nunca vai para o app.

## Testar sem Cloudflare

```powershell
node --test test/*.test.mjs
```
```powershell
node dev-server.mjs
```
O segundo comando abre `http://127.0.0.1:8790/` (senha `teste`) com dados de exemplo (`NO_DEMO=1` começa vazio). Usa o mesmo código do Worker, com um SQLite em memória no lugar do D1. **O que não é verificado assim:** o deploy real, a autenticação do `wrangler` e o comportamento do D1 na Cloudflare.

## Limites honestos

- Qualquer pessoa pode enviar avisos falsos ao endereço público (o app é de código aberto, não há como esconder o formato). O Worker só aceita o formato exato e limita a taxa por IP (em memória, melhor esforço), mas os números não são à prova de fraude.
- Os números somam só quem aceitou enviar estatísticas: representam uma parte do uso real.
- A Cloudflare, como provedora do serviço, vê o IP de quem conecta; o Worker não o grava.
