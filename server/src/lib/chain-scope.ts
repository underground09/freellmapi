import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import type { ResolvedAuth } from './system-prompt.js';

/**
 * Alcance por cadena (nivel 2): una API de servicio es una clave de cliente
 * atada a UNA cadena de enrutamiento. Varias APIs pueden compartir la misma
 * cadena, pero ninguna puede salirse de ella.
 *
 * Reglas:
 *  - sin modelo, `auto` o `auto:<su cadena>` → se reescribe a su cadena;
 *  - un modelo que pertenece a la cadena → pasa tal cual;
 *  - cualquier otro (otra cadena, `fusion`, un modelo fuera del grupo) → 403.
 */

interface ChainRow {
  name: string;
}

interface ModelRow {
  model_id: string;
  display_name: string | null;
}

export function enforceProfileChain(auth: ResolvedAuth, req: Request, res: Response): boolean {
  if (auth.kind !== 'profile' || !auth.chainId) return true;

  const db = getDb();
  const chain = db.prepare('SELECT name FROM profiles WHERE id = ?').get(auth.chainId) as ChainRow | undefined;
  if (!chain) {
    res.status(403).json({
      error: { message: 'La cadena asignada a esta API ya no existe', type: 'chain_scope_error' },
    });
    return false;
  }

  const body = (req.body ?? {}) as { model?: unknown };
  const requested = typeof body.model === 'string' ? body.model.trim() : '';
  const own = `auto:${chain.name.toLowerCase()}`;
  const lower = requested.toLowerCase();

  if (!requested || lower === 'auto' || lower === own) {
    body.model = own;
    return true;
  }

  const models = db
    .prepare(
      `SELECT m.model_id, m.display_name
         FROM profile_models pm
         JOIN models m ON m.id = pm.model_db_id
        WHERE pm.profile_id = ? AND pm.enabled = 1`,
    )
    .all(auth.chainId) as ModelRow[];

  const allowed = models.some(
    model => model.model_id.toLowerCase() === lower
      || (model.display_name ?? '').toLowerCase() === lower,
  );

  if (!allowed) {
    res.status(403).json({
      error: {
        message: `Esta API sólo puede usar los modelos del grupo "${chain.name}"`,
        type: 'chain_scope_error',
      },
    });
    return false;
  }

  return true;
}
