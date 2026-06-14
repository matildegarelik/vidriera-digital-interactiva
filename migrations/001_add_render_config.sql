-- Migración: agrega la columna render_config a ar_models
-- Guarda la config de render/iluminación del armador 3D (fondo, exposición,
-- luces, entorno, espesores, curvatura) que NO viaja dentro del GLB estándar.
--
-- Ejecutar UNA vez en cada entorno (dev/prod) antes de usar el armador 3D.
--
-- MySQL / MariaDB:
--   mysql -u <user> -p <dbname> < migrations/001_add_render_config.sql
--
-- SQLite (dev, instance/default.db):
--   sqlite3 instance/default.db < migrations/001_add_render_config.sql
--   (En SQLite, ALTER TABLE ... ADD COLUMN da error si la columna ya existe;
--    ejecutarlo solo si todavía no fue aplicada.)

-- --- MySQL 5.7+ / 8.x (idempotente vía information_schema) ---
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ar_models'
    AND COLUMN_NAME = 'render_config'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE ar_models ADD COLUMN render_config JSON NULL',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- --- SQLite (alternativa; comentar el bloque MySQL de arriba si se usa esto) ---
-- ALTER TABLE ar_models ADD COLUMN render_config JSON;
