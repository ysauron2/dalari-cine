-- Estatísticas anônimas do Dalari Cine (Cloudflare D1, SQLite).
-- Sem endereço IP, sem nome, sem o que a pessoa assiste. O "id" é um número aleatório gerado no app, só com permissão.
-- Desenhado para ~1 escrita por aviso, para caber folgado no plano gratuito (100 mil escritas de linha por dia).

CREATE TABLE IF NOT EXISTS installs (
  id         TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,            -- segundos Unix
  last_seen  INTEGER NOT NULL,
  app        TEXT NOT NULL,               -- versão do app
  os         TEXT NOT NULL,               -- win | mac | linux | other
  state      TEXT NOT NULL,               -- idle | room | call
  state_ts   INTEGER NOT NULL
);

-- Uma linha por instalação ativa por dia (para pessoas ativas por dia/semana/mês).
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL,                      -- AAAA-MM-DD (UTC)
  id  TEXT NOT NULL,
  PRIMARY KEY (day, id)
);

-- Contadores por dia: salas criadas, chamadas iniciadas, duração em faixas, rota usada, falhas de voz.
CREATE TABLE IF NOT EXISTS counters (
  day  TEXT NOT NULL,
  name TEXT NOT NULL,
  key  TEXT NOT NULL DEFAULT '',
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, key)
);

-- Uma linha por instalação ativa por hora (UTC): mapa de horários de pico.
CREATE TABLE IF NOT EXISTS hourly (
  day  TEXT NOT NULL,
  hour INTEGER NOT NULL,
  id   TEXT NOT NULL,
  PRIMARY KEY (day, hour, id)
);

-- Último aviso enviado por tipo (para não repetir o mesmo alerta do Telegram a cada 30 minutos).
CREATE TABLE IF NOT EXISTS alerts (
  kind    TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);

-- Versões já vistas: para avisar a primeira pessoa que usa uma versão nova.
CREATE TABLE IF NOT EXISTS versions_seen (
  app        TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL
);
-- Quem já usa hoje conta como "já visto": sem isso, rodar este arquivo geraria um aviso por versão antiga.
INSERT OR IGNORE INTO versions_seen (app, first_seen) SELECT app, MIN(first_seen) FROM installs GROUP BY app;

-- Catálogo de títulos do TMDB (montado pelo Worker; o token fica só nele). Um detalhe por título e o catálogo final em catalog_meta.
CREATE TABLE IF NOT EXISTS catalog_items (
  id         TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
