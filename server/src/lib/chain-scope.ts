import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import type { ResolvedAuth } from './system-prompt.js';

/**
 * Alcance por cadena (nivel 2): una API de servicio está atada a uno o varios
 * enrutamientos. No puede pedir modelos que no estén en ninguno de ellos.
 *
 * Reglas:
 *  - sin modelo o `auto` con UN enrutamiento → se reescribe a ese enrutamiento;
 *  - `auto` con varios → 403, porque elegir por el cliente sería adivinar;
 *  - un modelo que pertenece a alguno de sus enrutamientos → pasa;
 *  - cualquier otro → 403 chain_scope_error.
 */

interface ModelRow {
  model_id: string;
  display_name: string | null;
}

function chainsFor(profileId: number, legacyChainId: number | null): number[] {
  const db = getDb();
  try {
    const rows = db
      .prepare('SELECT chain_id FROM client_profile_chains WHERE profile_id = ?')
      .all(profileId) as { chain_id: number }[];
    if (rows.length > 0) return rows.map(row => Number(row.chain_id));
  } catch {
    // tabla aún no migrada: se usa la columna antigua
  }
  return legacyChainId ? [legacyChainId] : [];
}

export function enforceProfileChain(auth: ResolvedAuth, req: Request, res: Response): boolean {
  if (auth.kind !== 'profile') return true;

  const chainIds = chainsFor(auth.profileId, auth.chainId ?? null);
  if (chainIds.length === 0) {
    // Sin enrutamiento asignado no hay grupo que respetar: se comporta como antes.
    return true;
  }

  const db = getDb();
  const body = (req.body ?? {}) as { model?: unknown };
  const requested = typeof body.model === 'string' ? body.model.trim() : '';
  const lower = requested.toLowerCase();

  const names = chainIds
    .map(id => db.prepare('SELECT name FROM profiles WHERE id = ?').get(id) as { name: string } | undefined)
    .filter((row): row is { name: string } => Boolean(row))
    .map(row => row.name);

  if (!requested || lower === 'auto') {
    if (names.length === 1) {
      body.model = `auto:${names[0].toLowerCase()}`;
      return true;
    }
    res.status(403).json({
      error: {
        message: `Esta API tiene ${names.length} enrutamientos: indica el modelo que quieres (${names.join(', ')})`,
        type: 'chain_scope_error',
      },
    });
    return false;
  }

  if (names.some(name => lower === `auto:${name.toLowerCase()}`)) return true;

  const models = db
    .prepare(
      `SELECT m.model_id, m.display_name
         FROM profile_models pm
         JOIN models m ON m.id = pm.model_db_id
        WHERE pm.profile_id IN (${chainIds.map(() => '?').join(',')}) AND pm.enabled = 1`,
    )
    .all(...chainIds) as ModelRow[];

  const allowed = models.some(
    model => model.model_id.toLowerCase() === lower
      || (model.display_name ?? '').toLowerCase() === lower,
  );

  if (!allowed) {
    res.status(403).json({
      error: {
        message: `Esta API sólo puede usar los modelos de: ${names.join(', ')}`,
        type: 'chain_scope_error',
      },
    });
    return false;
  }

  return true;
}
