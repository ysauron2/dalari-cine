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
