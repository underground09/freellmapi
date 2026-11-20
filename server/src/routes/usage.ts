import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

/**
 * % de uso por modelo.
 *
 * Cruza las dos fuentes que ya existen:
 *   - `rate_limit_usage`     → peticiones y tokens por platform+modelo+clave.
 *   - `provider_quota_state` → límite publicado y fecha de reinicio.
 *
 * Regla dura: si no hay límite publicado se devuelve `limit: null` y el panel
 * dice «sin límite». NUNCA 0 %: un 0 % cuando en realidad no se sabe es un dato
 * falso que el usuario ya marcó como inaceptable.
 *
 * Aviso de cuota: cada `platform` mide lo suyo. `gemini-cli` (Code Assist por
 * OAuth) y `google` (AI Studio) son contadores distintos y no se suman.
 */
export const usageRouter = Router();

const DAY_MS = 86_400_000;

interface UsageRow {
  platform: string;
  model_id: string;
  key_id: number;
  requests: number;
  tokens: number;
  last_at: number | null;
}

interface QuotaRow {
  limit_value: number | null;
  remaining_value: number | null;
  reset_at: string | null;
  metric: string;
}

interface ModelLimits {
  rpd: number | null;
  rpm: number | null;
}

function thresholds(pct: number | null): 'green' | 'amber' | 'red' | 'unknown' {
  if (pct === null) return 'unknown';
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'amber';
  return 'green';
}

usageRouter.get('/by-model', (req: Request, res: Response) => {
  const db = getDb();
  const window = req.query.window === 'month' ? 'month' : 'day';
  const windowMs = window === 'month' ? 30 * DAY_MS : DAY_MS;
  const sinceMs = Date.now() - windowMs;

  const keyFilter = Number(req.query.keyId);
  const platformFilter = typeof req.query.platform === 'string' && req.query.platform.trim()
    ? req.query.platform.trim()
    : null;

  const where: string[] = ['u.created_at_ms >= ?'];
  const params: (number | string)[] = [sinceMs];
  if (Number.isInteger(keyFilter) && keyFilter > 0) {
    where.push('u.key_id = ?');
    params.push(keyFilter);
  }
  if (platformFilter) {
    where.push('u.platform = ?');
    params.push(platformFilter);
  }

  const rows = db.prepare(`
    SELECT u.platform, u.model_id, u.key_id,
           SUM(CASE WHEN u.kind = 'request' THEN 1 ELSE 0 END) AS requests,
           SUM(CASE WHEN u.kind = 'tokens' THEN u.tokens ELSE 0 END) AS tokens,
           MAX(u.created_at_ms) AS last_at
      FROM rate_limit_usage u
     WHERE ${where.join(' AND ')}
     GROUP BY u.platform, u.model_id, u.key_id
     ORDER BY requests DESC
     LIMIT 500
  `).all(...params) as UsageRow[];

  const modelLimits = db.prepare(
    "SELECT rpd_limit AS rpd, rpm_limit AS rpm FROM models WHERE platform = ? AND model_id = ? ORDER BY (endpoint_scope = '') DESC LIMIT 1",
  );
  // Cuota POR MODELO primero (quota_pool_key = '<platform>::<model_id>'); si no hay,
  // se usa la de la plataforma. Así argon (semanal) no contamina a los demás.
  const quotaState = db.prepare(`
    SELECT limit_value, remaining_value, reset_at, metric, reset_strategy
      FROM provider_quota_state
     WHERE platform = ? AND key_id = ? AND limit_value IS NOT NULL
       AND (quota_pool_key = ? OR quota_pool_key NOT LIKE '%::%')
     ORDER BY CASE WHEN quota_pool_key = ? THEN 0 ELSE 1 END,
              CASE metric WHEN 'requests' THEN 0 WHEN 'rpm' THEN 1 ELSE 2 END,
              updated_at DESC
     LIMIT 1
  `);

  const items = rows.map(row => {
    const model = modelLimits.get(row.platform, row.model_id) as ModelLimits | undefined;
    const poolKey = `${row.platform}::${row.model_id}`;
    const quota = quotaState.get(row.platform, row.key_id, poolKey, poolKey) as QuotaRow | undefined;

    const esPorcentaje = quota?.metric === 'percent';
    const catalogLimit = window === 'day' ? (model?.rpd ?? null) : null;
    const limit = quota?.limit_value ?? catalogLimit;
    const used = esPorcentaje && quota?.remaining_value != null
      ? Math.max(0, Math.round((100 - Number(quota.remaining_value)) * 10) / 10)
      : row.requests;
    const pct = esPorcentaje && quota?.remaining_value != null
      ? Math.max(0, Math.round((100 - Number(quota.remaining_value)) * 10) / 10)
      : (limit && limit > 0 ? Math.min(999, Math.round((used / limit) * 1000) / 10) : null);

    // S = semanal, D = diario, según cuándo reinicia (o lo que declare el proveedor).
    let scope: string | null = null;
    if (quota?.reset_strategy === 'weekly') scope = 'S';
    else if (quota?.reset_strategy === 'daily') scope = 'D';
    else if (quota?.reset_at) {
      const horas = (new Date(quota.reset_at).getTime() - Date.now()) / 3_600_000;
      scope = horas > 30 ? 'S' : 'D';
    }

    return {
      model: row.model_id,
      platform: row.platform,
      keyId: row.key_id,
      window,
      used,
      tokens: row.tokens,
      limit,
      remaining: quota?.remaining_value ?? null,
      pct,
      resetAt: quota?.reset_at ?? null,
      scope,
      lastUsedAt: row.last_at ? new Date(row.last_at).toISOString() : null,
      status: thresholds(pct),
      limitSource: quota?.limit_value != null ? 'provider_quota_state' : (catalogLimit != null ? 'catalog' : null),
    };
  });

  res.json({
    window,
    since: new Date(sinceMs).toISOString(),
    checkedAt: new Date().toISOString(),
    total: items.length,
    withLimit: items.filter(item => item.limit !== null).length,
    withoutLimit: items.filter(item => item.limit === null).length,
    items,
  });
});
