'use strict';
/* Inicia o serviço de sala. Padrão: 127.0.0.1:8787, sem log de requisições. NÃO é implantação. */
const { createRoomService } = require('./room-service.js');
const { loadTmdbCatalog } = require('./tmdb-catalog.js');
const { loadRemoteCatalog } = require('./catalog-source.js');
const { createRemoteIce } = require('./remote-ice.js');
const fs = require('node:fs/promises');
const path = require('node:path');

const host = process.env.HOST || '127.0.0.1';
const port = process.env.PORT ? Number(process.env.PORT) : 8787;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
let service;

// Voz pela internet: STUN/TURN. ICE_SERVERS_JSON (lista JSON, ex.: serviço TURN gerenciado) substitui o padrão;
// TURN_URLS + TURN_SECRET ativam credenciais temporárias para um coturn próprio (use-auth-secret).
// Sem nenhuma variável, usa só um STUN público (revela o IP público do aparelho ao provedor STUN).
function iceConfig() {
  const raw = process.env.ICE_SERVERS_JSON;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (raw) {
    try { iceServers = JSON.parse(raw); } catch { throw new Error('ICE_SERVERS_JSON não é um JSON válido.'); }
  }
  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const turn = urls.length ? { urls, secret: process.env.TURN_SECRET || '', ttlSec: process.env.TURN_TTL_SEC ? Number(process.env.TURN_TTL_SEC) : undefined } : null;
  return { iceServers, turn };
}

// Estatísticas anônimas (opcionais): o endereço fica em stats-config.json; aqui só liberamos essa origem na CSP da página.
function statsOrigin() {
  try {
    const c = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'stats-config.json'), 'utf8'));
    const u = new URL(c.url);
    const ok = u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));   // http só em loopback (testes locais)
    return ok && !u.username && !u.password ? u.origin : '';
  } catch { return ''; }
}

async function start() {
  const ice = iceConfig();
  let catalog = null;
  let catalogMode = 'demo';
  if (process.env.TMDB_READ_ACCESS_TOKEN) {
    try { catalog = await loadTmdbCatalog(process.env.TMDB_READ_ACCESS_TOKEN); catalogMode = 'live'; }
    catch { throw new Error('Catálogo TMDB indisponível ou sem títulos confirmados nos serviços selecionados no Brasil. Confira o token e a conexão.'); }
  } else {
    // 1º o catálogo do serviço do criador (atualizado todo dia, com duração e trailer); sem rede ou sem catálogo lá, o que veio junto com o app
    catalog = await loadRemoteCatalog({ origin: statsOrigin() });
    if (catalog) catalogMode = 'remote';
    else {
      const snapshotPath = path.join(__dirname, '..', 'data', 'tmdb-catalog-br.json');
      try {
        catalog = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
        if (!Array.isArray(catalog) || catalog.length === 0) throw new Error('invalid_catalog_snapshot');
        catalogMode = 'snapshot';
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  // Retransmissor (TURN) do serviço do criador, só como reserva quando a conexão direta não abre; DUOTELA_NO_RELAY=1 desliga
  const origin = statsOrigin();
  const remoteIce = origin && process.env.DUOTELA_NO_RELAY !== '1' ? createRemoteIce({ url: origin + '/v1/ice' }) : null;
  service = createRoomService({ remoteIce, allowedOrigins, allowNonLoopback: process.env.ALLOW_NON_LOOPBACK === '1', servePrototype: true, catalog, catalogSource: catalog ? 'tmdb' : 'demo', youtubeApiKey: process.env.YOUTUBE_DATA_API_KEY || null, iceServers: ice.iceServers, turn: ice.turn, statsOrigin: statsOrigin(), ...(process.env.DUOTELA_RELAY_ORIGINS ? { relayOrigins: process.env.DUOTELA_RELAY_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean) } : {}) });
  const a = await service.listen(port, host);
  remoteIce?.warm();
  console.log(`Dalari Cine room service em http://${a.address}:${a.port} (HTTP puro, sem TLS: só desenvolvimento local).`);
  console.log(`Voz: ${ice.iceServers.length} servidor(es) STUN/ICE${ice.turn ? ' + TURN com credenciais temporárias' : ', sem TURN (algumas redes não conectarão a voz)'}.`);
  console.log(`Interface de teste: http://127.0.0.1:${a.port}/`);
  console.log(catalog ? `Catálogo TMDB ${catalogMode === 'live' ? 'consultado' : catalogMode === 'remote' ? 'do serviço do criador' : 'local'}: ${catalog.length} títulos. ${catalogMode === 'snapshot' ? 'A disponibilidade reflete a última consulta, não uma verificação em tempo real.' : 'Disponibilidade consultada no Brasil.'}` : 'Catálogo fictício de demonstração ativo. Configure TMDB_READ_ACCESS_TOKEN para consultar o TMDB.');
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    console.warn('AVISO: interface não-loopback. Coloque HTTPS e limite de taxa num proxy reverso confiável.');
  }
}
start().catch((e) => { console.error(e.message); process.exit(1); });

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => service?.close().then(() => process.exit(0)) || process.exit(0));
