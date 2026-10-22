'use strict';
// Endereços que a interface pode pedir para abrir no navegador padrão (Sobre e créditos). Lista fechada: nada vindo de
// página, convite ou sala chega aqui. Mantenha igual a LINKS em web/server/first-run.js (há um teste que confere).
const ALLOWED = new Set([
  'https://github.com/ysauron2',
  'https://github.com/ysauron2/dalari-cine'
]);
const isAllowedExternal = (url) => typeof url === 'string' && ALLOWED.has(url);
module.exports = { isAllowedExternal, ALLOWED };
