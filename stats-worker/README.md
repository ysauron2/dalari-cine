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
