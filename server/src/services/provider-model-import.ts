import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { resolveProvider } from '../providers/index.js';
import { refreshOauthKey } from './gemini-oauth.js';
import type { Platform } from '@freellmapi/shared/types.js';

/**
 * Importar el catálogo de modelos DEL PROVEEDOR a la tabla `models`.
 *
 * Por qué existe: el catálogo que sincroniza la app viene de una instantánea
 * mensual firmada y no incluye a todos los proveedores registrados (huggingface
 * y ollama no aparecen, por ejemplo). Una cadena creada con `platform` se
 * rellena desde `models`, así que sin filas la cadena sale 0/0 y el panel dice
 * que no hay modelos disponibles. Aquí se pide la lista al propio proveedor con
 * la clave del operador y se guarda.
 *
 * Reglas:
 *  - Idempotente: la PK única es (platform, model_id, endpoint_scope); las filas
 *    importadas usan endpoint_scope = '' y se hace UPSERT, nunca INSERT a ciegas.
 *  - Nunca pisa lo que el operador ya ajustó: en conflicto sólo se rellenan
 *    huecos (contexto nulo, capacidades a 0) y se fuerza enabled = 1.
 *  - `source = 'provider'` para que el pruner de catalog-sync no se las lleve
 *    (ver isCatalogManagedModel).
 */

export interface ImportedModel {
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
}

export interface ImportModelsResult {
  platform: string;
  keyId: number | null;
  fetched: number;
  created: number;
  updated: number;
  total: number;
  models: ImportedModel[];
  catalogUrl: string | null;
  fetchedAt: string;
}

export class ModelImportError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(message: string, status = 400, detail?: string) {
    super(message);
    this.name = 'ModelImportError';
    this.status = status;
    this.detail = detail;
  }
}

interface KeyRow {
  id: number;
  platform: string;
  kind?: string | null;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  enabled: number;
}

/** Modelos del cliente Gemini CLI (Code Assist). El endpoint de Code Assist no
 *  publica un /models que se pueda usar como catálogo, así que la lista viaja
 *  con el código, igual que en el registro del cliente oficial. */
const GEMINI_CLI_MODELS: ImportedModel[] = [
  { modelId: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.1-flash-lite-preview', displayName: 'Gemini 3.1 Flash Lite Preview', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite', contextWindow: 1048576, supportsVision: true, supportsTools: true },
];


/** Modelos de Antigravity (registro del IDE). Se usa el `upstreamModelId`
 *  cuando existe: es el id que espera el endpoint de Code Assist. */
const ANTIGRAVITY_MODELS: ImportedModel[] = [
  { modelId: 'gemini-3.7-flash-tiered(high)', displayName: 'Gemini 3.7 Flash (High)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.7-flash-tiered(medium)', displayName: 'Gemini 3.7 Flash (Medium)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.7-flash-tiered(low)', displayName: 'Gemini 3.7 Flash (Low)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.6-flash-tiered(high)', displayName: 'Gemini 3.6 Flash (High)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.6-flash-tiered(medium)', displayName: 'Gemini 3.6 Flash (Medium)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.6-flash-tiered(low)', displayName: 'Gemini 3.6 Flash (Low)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.5-flash-high', displayName: 'Gemini 3.5 Flash (High)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (Agent)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Medium)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.5-flash-extra-low', displayName: 'Gemini 3.5 Flash (Low)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-pro-agent', displayName: 'Gemini 3.1 Pro (High)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)', contextWindow: 1048576, supportsVision: true, supportsTools: true },
  { modelId: 'gemini-3-flash', displayName: 'Gemini 3 Flash', contextWindow: 1048576, supportsVision: true, supportsTools: true },
];

/** baseUrl del catálogo cuando el provider no expone `modelsUrl`. */
const CATALOG_FALLBACK: Partial<Record<Platform, string>> = {
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
};

function catalogUrlFor(platform: Platform, row: KeyRow): { url: string; auth: 'bearer' | 'goog' } {
  if (platform === 'custom' && row.base_url) {
    return { url: `${row.base_url.replace(/\/+$/, '')}/models`, auth: 'bearer' };
  }
  const provider = resolveProvider(platform) as unknown as { modelsUrl?: string } | undefined;
  const url = provider?.modelsUrl ?? CATALOG_FALLBACK[platform];
  if (!url) {
    throw new ModelImportError(`El proveedor «${platform}» no publica un catálogo de modelos consultable`, 400);
  }
  return { url, auth: platform === 'google' ? 'goog' : 'bearer' };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function maxProviderContext(entry: Record<string, unknown>): number | null {
  const providers = entry.providers;
  if (!Array.isArray(providers)) return null;
  let best: number | null = null;
  for (const item of providers) {
    const ctx = asNumber((item as Record<string, unknown>)?.context_length);
    if (ctx !== null && (best === null || ctx > best)) best = ctx;
  }
  return best;
}

function hasImageInput(entry: Record<string, unknown>): boolean {
  const architecture = entry.architecture as Record<string, unknown> | undefined;
  const modalities = architecture?.input_modalities;
  if (Array.isArray(modalities) && modalities.includes('image')) return true;
  const capabilities = entry.capabilities;
  return Array.isArray(capabilities) && capabilities.includes('vision');
}

function hasTools(entry: Record<string, unknown>): boolean {
  const capabilities = entry.capabilities;
  if (Array.isArray(capabilities) && capabilities.includes('tools')) return true;
  const providers = entry.providers;
  if (Array.isArray(providers)) {
    return providers.some(item => (item as Record<string, unknown>)?.supports_tools === true);
  }
  return false;
}

/** Traduce la respuesta de cada familia de proveedor a una forma común. */
function normalizeCatalog(platform: Platform, payload: unknown): ImportedModel[] {
  const body = (payload ?? {}) as Record<string, unknown>;
  const out: ImportedModel[] = [];

  // OpenAI-compatible: { data: [{ id, ... }] }
  if (Array.isArray(body.data)) {
    for (const raw of body.data as Record<string, unknown>[]) {
      const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
      if (!id) continue;
      out.push({
        modelId: id,
        displayName: id,
        contextWindow: asNumber(raw.context_length) ?? asNumber(raw.context_window) ?? maxProviderContext(raw),
        supportsVision: hasImageInput(raw),
        supportsTools: hasTools(raw),
      });
    }
    return out;
  }

  // Ollama /api/tags: { models: [{ name, capabilities }] }
  if (Array.isArray(body.models)) {
    for (const raw of body.models as Record<string, unknown>[]) {
      // Google devuelve `name: "models/gemini-..."`; Ollama devuelve el tag tal cual.
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      if (!name) continue;
      if (platform === 'google' || name.startsWith('models/')) {
        const methods = raw.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
        const id = name.replace(/^models\//, '');
        out.push({
          modelId: id,
          displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : id,
          contextWindow: asNumber(raw.inputTokenLimit),
          supportsVision: false,
          supportsTools: false,
        });
        continue;
      }
      out.push({
        modelId: name,
        displayName: name,
        contextWindow: null,
        supportsVision: hasImageInput(raw),
        supportsTools: hasTools(raw),
      });
    }
    return out;
  }

  return out;
}

async function fetchCatalog(platform: Platform, row: KeyRow, apiKey: string): Promise<{ models: ImportedModel[]; url: string }> {
  if (platform === 'gemini-cli') {
    return { models: GEMINI_CLI_MODELS.map(model => ({ ...model })), url: 'registry:gemini-cli' };
  }
  if (platform === 'antigravity') {
    // La lista real (con cuota y reset) la publica el propio Code Assist.
    try {
      const secret = JSON.parse(apiKey) as { accessToken?: string; projectId?: string };
      const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret.accessToken ?? ''}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/ide/2.1.1 darwin/arm64',
          'x-request-source': 'local',
        },
        body: JSON.stringify({ project: secret.projectId ?? '' }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const payload = (await res.json()) as { models?: Record<string, Record<string, unknown>> };
        const entries = Object.entries(payload.models ?? {});
        const models = entries
          // Fuera las pestañas y los modelos de imagen: no sirven en /v1/chat.
          .filter(([id]) => !id.startsWith('tab_') && !/image/.test(id) && !id.startsWith('chat_'))
          .map(([id, meta]) => ({
            modelId: id,
            displayName: typeof meta?.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : id,
            contextWindow: asNumber(meta?.maxTokens),
            supportsVision: meta?.supportsVideo === true || meta?.supportsImages === true,
            supportsTools: true,
          }));
        if (models.length > 0) {
          return { models, url: 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels' };
        }
      }
    } catch {
      // cae a la lista estática de abajo
    }
    return { models: ANTIGRAVITY_MODELS.map(model => ({ ...model })), url: 'registry:antigravity' };
  }

  const { url, auth } = catalogUrlFor(platform, row);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth === 'goog') headers['x-goog-api-key'] = apiKey;
  else headers.Authorization = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new ModelImportError(
      `No se pudo contactar con el catálogo de ${platform}`,
      502,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ModelImportError(
      `El proveedor ${platform} devolvió ${res.status} al listar sus modelos`,
      res.status === 401 || res.status === 403 ? 424 : 502,
      text.slice(0, 300),
    );
  }

  const payload = await res.json().catch(() => null);
  const models = normalizeCatalog(platform, payload);
  if (models.length === 0) {
    throw new ModelImportError(`El proveedor ${platform} no devolvió modelos utilizables`, 502);
  }
  return { models, url };
}

function upsertModels(platform: Platform, models: ImportedModel[]): { created: number; updated: number } {
  const db = getDb();
  const findExisting = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ?');
  const update = db.prepare(`
    UPDATE models SET
      context_window = COALESCE(context_window, ?),
      supports_vision = MAX(supports_vision, ?),
      supports_tools = MAX(supports_tools, ?),
      enabled = 1,
      source = CASE WHEN source = 'catalog' THEN 'catalog' ELSE 'provider' END
    WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      context_window, enabled, supports_vision, supports_tools, source, endpoint_scope
    ) VALUES (?, ?, ?, 500, 500, '', ?, 1, ?, ?, 'provider', '')
  `);

  let created = 0;
  let updated = 0;
  const run = db.transaction(() => {
    for (const model of models) {
      const existing = findExisting.get(platform, model.modelId, '') as { id: number } | undefined;
      if (existing) {
        update.run(model.contextWindow, model.supportsVision ? 1 : 0, model.supportsTools ? 1 : 0, existing.id);
        updated += 1;
      } else {
        insert.run(
          platform,
          model.modelId,
          model.displayName,
          model.contextWindow,
          model.supportsVision ? 1 : 0,
          model.supportsTools ? 1 : 0,
        );
        created += 1;
      }
    }
  });
  run();
  return { created, updated };
}

function countModels(platform: Platform): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM models WHERE platform = ?').get(platform) as { n: number };
  return row?.n ?? 0;
}

function loadKeyRow(keyId: number): KeyRow {
  const row = getDb()
    .prepare('SELECT id, platform, kind, encrypted_key, iv, auth_tag, base_url, enabled FROM api_keys WHERE id = ?')
    .get(keyId) as KeyRow | undefined;
  if (!row) throw new ModelImportError('Clave no encontrada', 404);
  return row;
}

/** Importa el catálogo del proveedor usando la clave indicada. */
export async function importModelsForKey(keyId: number): Promise<ImportModelsResult> {
  let row = loadKeyRow(keyId);
  // Una clave OAuth lleva access_token con caducidad: si está dentro del margen
  // se renueva aquí, porque el refresco periódico vive en el middleware de /v1
  // y esta ruta no pasa por ahí (sin esto, el catálogo daba 401 y caía a la
  // lista estática).
  if (row.kind === 'oauth') {
    await refreshOauthKey(row.id).catch(() => undefined);
    row = loadKeyRow(keyId);
  }
  const platform = row.platform as Platform;
  const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  const { models, url } = await fetchCatalog(platform, row, apiKey);
  const { created, updated } = upsertModels(platform, models);
  return {
    platform,
    keyId: row.id,
    fetched: models.length,
    created,
    updated,
    total: countModels(platform),
    models,
    catalogUrl: url,
    fetchedAt: new Date().toISOString(),
  };
}

/** Sincroniza por plataforma: usa la mejor clave disponible de ese proveedor. */
export async function importModelsForPlatform(platform: Platform): Promise<ImportModelsResult> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id FROM api_keys
        WHERE platform = ? AND enabled = 1
        ORDER BY CASE status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, id
        LIMIT 1`,
    )
    .get(platform) as { id: number } | undefined;
  if (!row) {
    throw new ModelImportError(`No hay ninguna clave de ${platform} para pedirle el catálogo`, 404);
  }
  return importModelsForKey(row.id);
}
