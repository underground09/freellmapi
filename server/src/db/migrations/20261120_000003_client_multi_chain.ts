import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

/**
 * Varias cadenas por API de servicio, y ficha del suscriptor.
 *
 * `client_profile_chains` es la tabla real de asignación (N:M): una API puede
 * apuntar a varios enrutamientos y un enrutamiento lo comparten varias APIs.
 * La columna antigua `chain_id` se conserva como "primera cadena" para no
 * romper nada y para el alcance rápido.
 */
export function up(db: Db): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS client_profile_chains (
      profile_id INTEGER NOT NULL REFERENCES client_profiles(id) ON DELETE CASCADE,
      chain_id   INTEGER NOT NULL,
      PRIMARY KEY (profile_id, chain_id)
    )`).run();

  for (const column of ['subscriber', 'notes', 'activated_at']) {
    if (!hasColumn(db, 'client_profiles', column)) {
      db.prepare(`ALTER TABLE client_profiles ADD COLUMN ${column} TEXT`).run();
    }
  }

  db.prepare(`INSERT OR IGNORE INTO client_profile_chains (profile_id, chain_id)
              SELECT id, chain_id FROM client_profiles WHERE chain_id IS NOT NULL`).run();
}

export function down(db: Db): void {
  try {
    db.prepare('DROP TABLE IF EXISTS client_profile_chains').run();
  } catch {
    // best-effort
  }
}
