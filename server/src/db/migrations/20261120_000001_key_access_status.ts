import type { Db } from '../types.js';

/** Guard so the migration can be re-run safely (roundtrip/catalog-sync tests re-run up()). */
function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

/**
 * Acceso por API (no por modelo): separa "¿esta credencial funciona?" — el
 * `status` de salud que escribe services/health.ts — de "¿esta API está
 * contratada o en periodo de prueba?", que es lo que apaga el operador.
 *
 * `status` reutiliza la columna existente porque el router ya sólo enruta
 * 'healthy'/'unknown'; con eso, escribir 'disabled' / 'expired' / 'billing'
 * saca la clave de todas las cadenas sin tocar ni un modelo.
 *
 * `kind` y `oauth_provider` dejan sitio a las credenciales que llegan por OAuth
 * (Gemini CLI) en vez de por clave pegada a mano.
 */
export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'kind')) {
    db.prepare("ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'api-key'").run();
  }
  if (!hasColumn(db, 'api_keys', 'oauth_provider')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN oauth_provider TEXT').run();
  }
  if (!hasColumn(db, 'api_keys', 'expires_at')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN expires_at TEXT').run();
  }
  if (!hasColumn(db, 'api_keys', 'status_reason')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN status_reason TEXT').run();
  }
}

export function down(db: Db): void {
  for (const column of ['kind', 'oauth_provider', 'expires_at', 'status_reason']) {
    if (hasColumn(db, 'api_keys', column)) {
      try {
        db.prepare(`ALTER TABLE api_keys DROP COLUMN ${column}`).run();
      } catch {
        // best-effort: some builds pin the table; leaving the column harms nobody
      }
    }
  }
}
