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

| Comando | Resposta |
| --- | --- |
| `/agora` | quantas pessoas estão com o app aberto neste momento (últimos 5 min), em sala e em chamada, mais o resumo de hoje |
| `/hoje` | todos os contadores de hoje (UTC) |
| `/semana` | o resumo dos últimos 7 dias |
| `/erros` | erros do app hoje e na semana |
| `/ajuda` | a lista de comandos |

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

Regras de alerta (em `src/alerts.js`): pareamento com 40% ou mais de falhas (mínimo 5 tentativas), voz com 40% ou mais de falhas (ou 8 falhas), qualidade ruim em 40% ou mais das chamadas medidas (mínimo 5), ou 10 erros do app no dia (ou 5 do mesmo tipo). Os limites ficam no código e podem ser ajustados.

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
