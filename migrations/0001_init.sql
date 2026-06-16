-- Dagens Pod – datamodell
-- En rad per dygn (date ar UNIQUE -> idempotent generering).

CREATE TABLE IF NOT EXISTS recommendations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT    NOT NULL UNIQUE,          -- YYYY-MM-DD
  episode_title    TEXT    NOT NULL,
  show_name        TEXT    NOT NULL,
  show_slug        TEXT    NOT NULL,                 -- normaliserad for gruppering
  hosts            TEXT    NOT NULL DEFAULT '',
  genre            TEXT    NOT NULL DEFAULT '',
  language         TEXT    NOT NULL DEFAULT '',
  year             INTEGER,
  duration_minutes INTEGER,
  why_great        TEXT    NOT NULL,
  listen_links     TEXT    NOT NULL DEFAULT '{}',    -- JSON: { apple, spotify, web, ... }
  sources          TEXT    NOT NULL DEFAULT '[]',    -- JSON: [{ title, url }]
  created_at       TEXT    NOT NULL                  -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_recommendations_date      ON recommendations(date);
CREATE INDEX IF NOT EXISTS idx_recommendations_show_slug ON recommendations(show_slug);
CREATE INDEX IF NOT EXISTS idx_recommendations_genre     ON recommendations(genre);
CREATE INDEX IF NOT EXISTS idx_recommendations_language  ON recommendations(language);
