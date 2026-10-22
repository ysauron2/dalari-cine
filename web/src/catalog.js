/* Catálogo fictício e estático do Dalari Cine. Nenhum título aqui existe em serviço de streaming.
   Formato UMD: <script src> no navegador (funciona em file://) e require() no Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DuoCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return [
    { id: 'noite', title: 'Noite a Dois', kind: 'Filme', service: 'Filme exemplo', genre: 'Romance', minutes: 112, image: 'assets/noite-a-dois.png', description: 'Uma cidade iluminada, uma conversa que muda tudo e uma noite que vale guardar.', tags: ['romance', 'drama'], warmth: 5, adventure: 2 },
    { id: 'mar', title: 'Mar de Inverno', kind: 'Filme', service: 'Filme exemplo', genre: 'Drama', minutes: 126, image: 'assets/mar-de-inverno.png', description: 'Uma viagem à costa revela antigas promessas e novos começos.', tags: ['drama', 'aventura'], warmth: 4, adventure: 3 },
    { id: 'horizonte', title: 'Outro Horizonte', kind: 'Série', service: 'Série exemplo', genre: 'Ficção científica', minutes: 48, image: 'assets/outro-horizonte.png', description: 'Dois exploradores descobrem o que realmente significa encontrar um lar.', tags: ['ficção', 'aventura'], warmth: 3, adventure: 5 },
    { id: 'cafe', title: 'Café com Vento Sul', kind: 'Filme', service: 'Filme exemplo', genre: 'Comédia', minutes: 94, image: 'assets/cafe-vento-sul.svg', description: 'Dois donos de cafés rivais dividem um toldo, uma ventania e uma semana de confusões.', tags: ['comédia', 'romance'], warmth: 4, adventure: 1 },
    { id: 'relogio', title: 'A Casa do Relógio Parado', kind: 'Filme', service: 'Filme exemplo', genre: 'Suspense', minutes: 103, image: 'assets/casa-relogio-parado.svg', description: 'Uma herança, uma casa onde o tempo parou às 3h07 e um segredo que alguém quer manter.', tags: ['suspense', 'mistério'], warmth: 1, adventure: 3 },
    { id: 'farois', title: 'Pequenos Faróis', kind: 'Filme', service: 'Filme exemplo', genre: 'Animação', minutes: 78, image: 'assets/pequenos-farois.svg', description: 'Dois faróis de brinquedo aprendem a iluminar o caminho um do outro numa noite de tempestade.', tags: ['animação', 'aventura'], warmth: 5, adventure: 3 },
    { id: 'salelima', title: 'Sal & Lima', kind: 'Série', service: 'Série exemplo', genre: 'Comédia', minutes: 26, image: 'assets/sal-e-lima.svg', description: 'Episódios curtos sobre um casal que tenta abrir um restaurante na cozinha de casa.', tags: ['comédia', 'romance'], warmth: 4, adventure: 1 },
    { id: 'cartografo', title: 'O Cartógrafo de Nuvens', kind: 'Série', service: 'Série exemplo', genre: 'Fantasia', minutes: 54, image: 'assets/cartografo-de-nuvens.svg', description: 'Uma cartógrafa e um piloto de balão desenham o mapa de um céu que muda de lugar.', tags: ['fantasia', 'aventura'], warmth: 3, adventure: 5 },
    { id: 'rotas', title: 'Rotas do Silêncio', kind: 'Filme', service: 'Documentário exemplo', genre: 'Documentário', minutes: 68, image: 'assets/rotas-do-silencio.svg', description: 'Um documentário contemplativo sobre trilhas feitas ao amanhecer, sem pressa e quase sem palavras.', tags: ['documentário', 'natureza'], warmth: 2, adventure: 2 }
  ];
});
