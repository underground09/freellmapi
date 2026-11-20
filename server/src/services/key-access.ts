import { getDb } from '../db/index.js';

/**
 * Acceso por API, no por modelo.
 *
 * El router sólo considera claves con `status` 'healthy' o 'unknown'
 * (services/router.ts). Por eso bloquear una API no obliga a tocar modelos:
 * se escribe un estado de acceso en la clave y **todas** sus cadenas caen a la
 * vez, mientras el health checker sigue viendo la credencial como válida.
 *
 * Motivos previstos: cobro pendiente, fin de prueba, revocada por el proveedor.
 */
export type KeyAccessStatus = 'active' | 'disabled' | 'expired' | 'billing';

export const KEY_ACCESS_STATUSES: KeyAccessStatus[] = ['active', 'disabled', 'expired', 'billing'];

/** Estados que jamás deben entrar en una cadena de enrutamiento. */
export const BLOCKED_KEY_STATUSES_SQL = "'disabled', 'expired', 'billing'";

const DEFAULT_EXPIRED_REASON = 'Acceso caducado (fin de prueba o suscripción)';

export function isBlockedKeyStatus(status: string | null | undefined): boolean {
  return status === 'disabled' || status === 'expired' || status === 'billing';
}

/**
 * Cambia el estado de acceso de una API.
 *
 * `active` vuelve a poner la clave en circulación dejando `status = 'unknown'`,
 * para que el siguiente pase de health valide la credencial en vez de dar por
 * bueno un 'healthy' viejo.
 */
export function setKeyAccessStatus(
  keyId: number,
  status: KeyAccessStatus,
  reason?: string | null,
  expiresAt?: string | null,
): void {
  const db = getDb();
  if (status === 'active') {
    db.prepare(
      `UPDATE api_keys
          SET status = 'unknown', enabled = 1, status_reason = NULL,
              expires_at = COALESCE(?, expires_at)
        WHERE id = ?`,
    ).run(expiresAt ?? null, keyId);
    return;
  }

  db.prepare(
    `UPDATE api_keys
        SET status = ?, status_reason = COALESCE(?, status_reason),
            expires_at = COALESCE(?, expires_at)
      WHERE id = ?`,
  ).run(status, reason ?? null, expiresAt ?? null, keyId);
}

/**
 * Cierra las APIs cuyo periodo terminó. Se llama al empezar cada pase de health
 * (cada ~5 min) y desde el endpoint de acceso, así que la ventana en la que una
 * clave caducada podría seguir sirviendo es acotada.
 */
export function expireOverdueKeys(): number {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE api_keys
          SET status = 'expired',
              status_reason = COALESCE(status_reason, ?)
        WHERE expires_at IS NOT NULL
          AND datetime(expires_at) <= datetime('now')
          AND status NOT IN (${BLOCKED_KEY_STATUSES_SQL})`,
    )
    .run(DEFAULT_EXPIRED_REASON);
  return Number(result.changes ?? 0);
}
