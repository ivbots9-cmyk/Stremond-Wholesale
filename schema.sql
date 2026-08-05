-- Схема базы плана склада. Отдельная база, ничего общего с остальным
-- содержимым репозитория.
--
-- Применяется командой из warehouse/README.md:
--   npx wrangler d1 execute warehouse --remote --file=warehouse/schema.sql
--
-- Почему хранение документами, а не таблицей на каждую сущность.
-- План — это связный снимок дня: блоки, объёмы, кто отсутствует. Читается
-- он всегда целиком (планшет показывает день), пишется тоже целиком
-- (нажали «Сохранить» — уехал день). Разложив это на пять таблиц, мы бы
-- получили пять запросов на каждую отрисовку и необходимость миграции
-- при каждом новом поле в блоке. На четырёх сотрудниках это чистый
-- проигрыш, поэтому здесь один документ на ключ.

CREATE TABLE IF NOT EXISTS wh_doc (
  key        TEXT PRIMARY KEY,   -- 'config' | 'day:2026-08-04'
  body       TEXT NOT NULL,      -- JSON документа
  version    INTEGER NOT NULL,   -- растёт с каждой записью
  updated_at TEXT NOT NULL,
  updated_by TEXT                -- 'admin' | 'tablet'
);

-- Журнал правок. Нужен ради того самого контроля: кто передвинул план,
-- когда отметили отсутствие, кто закрыл задачу. Хранит короткое описание,
-- а не полный снимок — иначе база распухнет на ровном месте.
CREATE TABLE IF NOT EXISTS wh_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,         -- 'admin' | 'tablet'
  action  TEXT NOT NULL,         -- 'config' | 'day' | 'progress' | 'absence'
  target  TEXT,                  -- дата дня или ключ документа
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_wh_log_at ON wh_log(at);
