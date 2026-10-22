# Política de privacidade do Dalari Cine

Esta é a mesma política mostrada dentro do aplicativo (Perfil → Política de privacidade). Gerada por `web/tools/gen-privacy-md.mjs`; edite o texto em `web/server/first-run.js`.

## Quem somos

O Dalari Cine é um aplicativo gratuito de assistir junto, mantido por uma pessoa física. Dúvidas ou pedidos sobre privacidade: abra uma "issue" no repositório do projeto no GitHub.

## Dados guardados no seu computador

Nome de exibição, preferências, histórico, progresso e a sessão da Netflix ficam apenas no seu computador (no perfil do aplicativo e no armazenamento do navegador). Nada disso é enviado a um servidor do Dalari Cine, porque não existe servidor do Dalari Cine com conta de usuário.

## Dados que saem do seu computador

1) Conexão com a outra pessoa: um canal direto criptografado (WebRTC). Nele passam o estado da sala (votos, reprodução) e, pela voz, o áudio da conversa, que não passa por nenhum servidor nosso. 2) Código curto: mensagens cifradas de conexão enviadas ao serviço ntfy.sh, que vê o texto cifrado, o tamanho e o endereço de rede de quem conecta, mas não o conteúdo. 3) Descoberta de rota: consulta a um servidor STUN do Google, que vê o endereço de rede público do seu aparelho. 4) Catálogo de títulos e capas: consulta ao TMDB. 5) Vídeos do YouTube e a Netflix: carregados diretamente dos serviços deles, sob os termos e a política de cada um.

## Dados que não coletamos

Não coletamos nome real, e-mail, telefone, senhas, cartões, conteúdo de conversas, gravações de voz, o que você assiste nem a sua localização. Não há anúncios nem rastreamento.

## Estatísticas de uso (opcionais)

Versões que têm o serviço de estatísticas ativado perguntam antes e não enviam nada sem a sua permissão; versões sem o serviço não enviam estatísticas. Se você aceitar, a cada 2 minutos com o app aberto é enviado a um serviço do criador, hospedado na Cloudflare: um número aleatório da instalação (criado só quando você aceita e apagado quando você recusa), a versão, o sistema, se você está em sala ou em chamada e contadores agregados (salas criadas, chamadas iniciadas, duração em faixas, tipo de conexão, falhas de voz, etapas do pareamento por código curto, qualidade da chamada em faixas e tempo para conectar). O serviço também guarda, por hora, quais instalações estiveram ativas (para o mapa de horários de pico) e o dia da primeira vez e dos retornos (para medir se as pessoas voltam). Não são enviados nome, o que você assiste, conteúdo de conversa, códigos ou participantes de salas, e o serviço não guarda o seu endereço IP (a Cloudflare, como provedora do serviço, vê o IP na própria conexão). Você pode ver o que é enviado e desligar a qualquer momento em Perfil → Estatísticas anônimas.

## Atualizações do aplicativo

Se você deixar ligado em Perfil → Atualizações (é o padrão), o app consulta o GitHub (github.com/…/releases) 20 segundos depois de abrir e a cada 6 horas para saber se há versão nova. O GitHub vê o endereço de rede do seu aparelho nessa consulta, como em qualquer download; nada do Dalari Cine é enviado além do pedido do arquivo. Uma versão nova só é instalada quando você clica em Atualizar agora, e o app confere uma assinatura digital antes de abrir o instalador. Você pode desligar a verificação automática em Perfil.

## Como apagar seus dados

Feche o Dalari Cine e apague a pasta "Dalari Cine" em %APPDATA% (Windows) ou em ~/Library/Application Support (macOS). Versões de teste antigas usavam a pasta "DuoTela Teste"; o app a renomeia sozinho na primeira abertura. Isso remove nome, preferências, histórico e a sessão da Netflix. Desinstalar o aplicativo não apaga essa pasta por si só.

## Atualizações desta política

Versão 3, de 22/10/2026. Mudanças relevantes serão mostradas no aplicativo, e quem aceitou uma versão anterior das estatísticas será perguntado de novo.
