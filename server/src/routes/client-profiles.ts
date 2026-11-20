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
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
  // null clears the prompt (the profile key then authenticates without
  // injecting anything); absent leaves it untouched.
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullable().optional(),
  enabled: z.boolean().optional(),
  chainId: z.number().int().positive().nullable().optional(),
});

interface ProfileRow {
  id: number;
  name: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  system_prompt: string | null;
  chain_id: number | null;
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

function toJson(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKeyFor(row),
    systemPrompt: row.system_prompt,
    chainId: row.chain_id ?? null,
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
    modelCount = models.length;
  }

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
    INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, chain_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(parsed.data.name, hashClientProfileKey(key), encrypted, iv, authTag, prompt, parsed.data.chainId ?? null);
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

  const { name, systemPrompt, enabled, chainId } = parsed.data;
  const nextPrompt = systemPrompt === undefined
    ? row.system_prompt
    : (systemPrompt?.trim() || null);
  getDb().prepare(`
    UPDATE client_profiles
    SET name = ?, system_prompt = ?, enabled = ?, chain_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? row.name,
    nextPrompt,
    enabled === undefined ? row.enabled : (enabled ? 1 : 0),
    chainId === undefined ? row.chain_id : chainId,
    id,
  );
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
