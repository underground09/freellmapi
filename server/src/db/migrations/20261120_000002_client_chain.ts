import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

/**
 * Nivel 2 del panel: una API de servicio es una clave de cliente
 * (`client_profiles`) atada a una cadena de enrutamiento (`profiles`).
 *
 * La relación es N:1 a propósito: varias APIs comparten la misma cadena, así
 * que se crean menos grupos que APIs. `NULL` deja la clave apuntando a la
 * cadena activa global, que es el comportamiento anterior.
 */
export function up(db: Db): void {
  if (!hasColumn(db, 'client_profiles', 'chain_id')) {
    db.prepare('ALTER TABLE client_profiles ADD COLUMN chain_id INTEGER').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_client_profiles_chain ON client_profiles(chain_id)').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'client_profiles', 'chain_id')) {
    try {
      db.prepare('ALTER TABLE client_profiles DROP COLUMN chain_id').run();
    } catch {
      // best-effort
    }
  }
}
