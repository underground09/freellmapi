import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { mintClientProfileKey, hashClientProfileKey } from '../lib/system-prompt.js';

// Client-profile CRUD (#411), mounted under /api/client-profiles behind the
// dashboard session gate like every other admin route. The full `sk-cp-...`
// key is returned exactly once — from create and rotate; the list endpoint
// only ever shows the masked form (rendered from the encrypted copy, since
// the auth path stores nothing but a hash).

export const clientProfilesRouter = Router();

const MAX_NAME_LEN = 100;
// Generous ceiling — a system prompt is configuration, not a document.
const MAX_PROMPT_LEN = 32_000;

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullish(),
  // Cadena de enrutamiento a la que queda atada esta API de servicio.
  // Varias APIs pueden apuntar a la MISMA cadena: menos grupos que APIs.
  chainId: z.number().int().positive().nullish(),
  chainIds: z.array(z.number().int().positive()).max(50).optional(),
  subscriber: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
  // null clears the prompt (the profile key then authenticates without
  // injecting anything); absent leaves it untouched.
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullable().optional(),
  enabled: z.boolean().optional(),
  chainId: z.number().int().positive().nullable().optional(),
  chainIds: z.array(z.number().int().positive()).max(50).optional(),
  subscriber: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

interface ProfileRow {
  id: number;
  name: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  system_prompt: string | null;
  chain_id: number | null;
  subscriber: string | null;
  notes: string | null;
  activated_at: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function maskedKeyFor(row: Pick<ProfileRow, 'encrypted_key' | 'iv' | 'auth_tag'>): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function chainIdsFor(profileId: number): number[] {
  try {
    const rows = getDb().prepare('SELECT chain_id FROM client_profile_chains WHERE profile_id = ? ORDER BY chain_id').all(profileId) as { chain_id: number }[];
    return rows.map(row => Number(row.chain_id));
  } catch {
    return [];
  }
}

function replaceChains(profileId: number, chainIds: number[]): void {
  const db = getDb();
  db.prepare('DELETE FROM client_profile_chains WHERE profile_id = ?').run(profileId);
  const insert = db.prepare('INSERT OR IGNORE INTO client_profile_chains (profile_id, chain_id) VALUES (?, ?)');
  [...new Set(chainIds)].forEach(chainId => insert.run(profileId, chainId));
  db.prepare('UPDATE client_profiles SET chain_id = ? WHERE id = ?').run(chainIds[0] ?? null, profileId);
}

function toJson(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKeyFor(row),
    systemPrompt: row.system_prompt,
    chainId: row.chain_id ?? null,
    chainIds: chainIdsFor(row.id),
    subscriber: row.subscriber ?? null,
    notes: row.notes ?? null,
    activatedAt: row.activated_at ?? null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getProfile(id: number): ProfileRow | undefined {
  return getDb().prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as ProfileRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid profile id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Client profile not found' } });
}

// Disponibilidad real de una cadena: modelos activos cuyo proveedor tiene al
// menos una clave en circulación y que no están en cooldown. Barato y honesto:
// no inventa un ping que no se ha hecho.
const AVAILABILITY_SQL = `
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS available
  FROM (
    SELECT m.id,
           CASE WHEN EXISTS (
             SELECT 1 FROM api_keys k
              WHERE k.platform = m.platform AND k.enabled = 1
                AND k.status IN ('healthy', 'unknown')
           ) AND NOT EXISTS (
             SELECT 1 FROM rate_limit_cooldowns c
              WHERE c.model_id = m.model_id AND c.expires_at_ms > (strftime('%s','now') * 1000)
           ) THEN 1 ELSE 0 END AS ok
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
     WHERE pm.profile_id = ? AND pm.enabled = 1 AND m.enabled = 1
  )`;

clientProfilesRouter.get('/chains/:id/availability', (req: Request, res: Response) => {
  const chainId = Number(req.params.id);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    res.status(400).json({ error: { message: 'id invalido', type: 'invalid_request' } });
    return;
  }
  const row = getDb().prepare(AVAILABILITY_SQL).get(chainId) as { total: number; available: number | null };
  const total = Number(row?.total ?? 0);
  const available = Number(row?.available ?? 0);
  res.json({ chainId, total, available, unavailable: total - available, checkedAt: new Date().toISOString() });
});

// Crear un enrutamiento (cadena). Con `platform` se rellena solo con los
// modelos activos de ese proveedor, que es el caso de uso del panel: "quiero un
// enrutamiento que sólo sea nvidia" en un clic.
clientProfilesRouter.post('/chains', (req: Request, res: Response) => {
  const db = getDb();
  const body = (req.body ?? {}) as { name?: unknown; platform?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const platform = typeof body.platform === 'string' && body.platform.trim() ? body.platform.trim() : null;

  if (!name || name.length > 100) {
    res.status(400).json({ error: { message: 'El nombre del enrutamiento es obligatorio (máx. 100)', type: 'invalid_request' } });
    return;
  }
  if (db.prepare('SELECT id FROM profiles WHERE name = ?').get(name)) {
    res.status(409).json({ error: { message: 'Ya existe un enrutamiento con ese nombre', type: 'name_taken' } });
    return;
  }

  const info = db.prepare("INSERT INTO profiles (name, type) VALUES (?, 'custom')").run(name);
  const chainId = Number(info.lastInsertRowid);

  let modelCount = 0;
  if (platform) {
    const models = db.prepare('SELECT id FROM models WHERE platform = ? AND enabled = 1 ORDER BY intelligence_rank ASC').all(platform) as { id: number }[];
    const insert = db.prepare('INSERT OR IGNORE INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)');
    models.forEach((model, index) => insert.run(chainId, model.id, index));
    // El alta de una cadena en FreeLLMAPI siembra TODOS los modelos del catalogo.
    // Aqui se recorta a la plataforma pedida y se apaga el auto-include, que es
    // lo que el panel promete cuando dice "solo con los modelos de nvidia".
    db.prepare('DELETE FROM profile_models WHERE profile_id = ? AND model_db_id NOT IN (SELECT id FROM models WHERE platform = ?)').run(chainId, platform);
    modelCount = models.length;
  }
  db.prepare('UPDATE profiles SET auto_include_new_models = 0 WHERE id = ?').run(chainId);

  res.status(201).json({ id: chainId, name, model_count: modelCount, api_count: 0 });
});

// Cadenas de enrutamiento disponibles para atar una API de servicio. Es la
// lista corta a propósito: varias APIs pueden compartir la misma cadena, así
// que se crean menos grupos que APIs.
clientProfilesRouter.get('/chains', (_req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT p.id,
           p.name,
           COUNT(pm.model_db_id) AS model_count,
           (SELECT COUNT(*) FROM client_profiles cp WHERE cp.chain_id = p.id) AS api_count
    FROM profiles p
    LEFT JOIN profile_models pm ON pm.profile_id = p.id AND pm.enabled = 1
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE
  `).all() as { id: number; name: string; model_count: number; api_count: number }[];
  res.json(rows);
});

clientProfilesRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT * FROM client_profiles ORDER BY id').all() as ProfileRow[];
  res.json(rows.map(toJson));
});

clientProfilesRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'A profile name is required' } });
    return;
  }
  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const prompt = parsed.data.systemPrompt?.trim() || null;
  const info = getDb().prepare(`
    INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, chain_id, subscriber, notes, activated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(parsed.data.name, hashClientProfileKey(key), encrypted, iv, authTag, prompt, parsed.data.chainId ?? parsed.data.chainIds?.[0] ?? null, parsed.data.subscriber ?? null, parsed.data.notes ?? null);
  if (parsed.data.chainIds?.length) replaceChains(Number(info.lastInsertRowid), parsed.data.chainIds);
  const row = getProfile(Number(info.lastInsertRowid))!;
  // The only time the full key leaves the server (besides rotate).
  res.status(201).json({ ...toJson(row), key });
});

clientProfilesRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid profile update' } });
    return;
  }
  const row = getProfile(id);
  if (!row) return notFound(res);

  const { name, systemPrompt, enabled, chainId, chainIds, subscriber, notes } = parsed.data;
  const nextPrompt = systemPrompt === undefined
    ? row.system_prompt
    : (systemPrompt?.trim() || null);
  getDb().prepare(`
    UPDATE client_profiles
    SET name = ?, system_prompt = ?, enabled = ?, chain_id = ?, subscriber = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? row.name,
    nextPrompt,
    enabled === undefined ? row.enabled : (enabled ? 1 : 0),
    chainId === undefined ? row.chain_id : chainId,
    subscriber === undefined ? row.subscriber : subscriber,
    notes === undefined ? row.notes : notes,
    id,
  );
  if (Array.isArray(chainIds)) replaceChains(id, chainIds);
  res.json(toJson(getProfile(id)!));
});

clientProfilesRouter.post('/:id/rotate', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getProfile(id);
  if (!row) return notFound(res);

  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  getDb().prepare(`
    UPDATE client_profiles
    SET token_hash = ?, encrypted_key = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(hashClientProfileKey(key), encrypted, iv, authTag, id);
  res.json({ ...toJson(getProfile(id)!), key });
});

clientProfilesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const info = getDb().prepare('DELETE FROM client_profiles WHERE id = ?').run(id);
  if (info.changes === 0) return notFound(res);
  res.json({ success: true });
});
