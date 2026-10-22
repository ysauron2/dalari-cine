# Avisos de terceiros

O Dalari Cine usa e/ou carrega os componentes e serviços abaixo. Cada um tem a sua própria licença e termos; este arquivo é um resumo, não substitui os originais. Revise os termos antes de distribuir o aplicativo.

## Componentes embutidos no aplicativo

- **Electron for Content Security (ECS), da Castlabs**: variante do Electron com suporte a conteúdo protegido. O Electron é licenciado sob a MIT; verifique a licença e os termos da versão da Castlabs usada (`app/package.json`).
- **Widevine CDM, do Google**: módulo de descriptografia de conteúdo protegido, baixado em tempo de execução. Tem licença e termos próprios, e a reprodução protegida exige assinatura VMP (EVS da Castlabs). Quem recompila o aplicativo e o distribui deve ter a própria conta EVS e aceitar os termos da Castlabs.
- **Inter** (fonte variável, subconjunto latino): © The Inter Project Authors, licença **SIL Open Font License 1.1**; o texto acompanha o arquivo em `web/assets/fonts/INTER-LICENSE-OFL.txt`. Veja também `docs/midia/CREDITOS.md`.
- **Chromium** e suas dependências, incluídos no Electron: veja `LICENSES.chromium.html` dentro do aplicativo instalado.

## Serviços e conteúdo de terceiros

- **TMDB**: o catálogo de títulos, capas e notas usa a API do TMDB. *This product uses the TMDB API but is not endorsed or certified by TMDB.* A atribuição exigida é exibida no aplicativo quando o catálogo está ativo.
- **YouTube**: vídeos incorporados com o player oficial (IFrame Player API), sujeitos aos Termos de Serviço do YouTube.
- **Netflix**: acessada pelo site oficial, no login de cada pessoa. O Dalari Cine não captura, grava nem retransmite o vídeo. *Netflix é marca registrada da Netflix, Inc. O Dalari Cine não é afiliado, patrocinado nem aprovado pela Netflix.* O uso deve respeitar os Termos de Uso da Netflix.
- **ntfy.sh**: serviço gratuito de encontro usado no código curto. Recebe apenas texto cifrado.
- **Cloudflare (Workers e D1)**: hospeda o serviço opcional de estatísticas anônimas do criador (pasta `stats-worker`), só quando uma versão tem o endereço configurado e a pessoa permite o envio.
- **Google STUN** (`stun.l.google.com`): descoberta de rota da conexão direta.

## Marcas

"Prime Video", "Crunchyroll" e demais nomes de serviços citados pertencem aos seus donos e são usados apenas para identificar os serviços com os quais o Dalari Cine pode ser usado.
