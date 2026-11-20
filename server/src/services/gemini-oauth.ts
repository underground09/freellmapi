import { randomBytes } from 'node:crypto';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { setKeyAccessStatus } from './key-access.js';

/**
 * OAuth de cuentas Google para Code Assist, con DOS proveedores:
 *
 *  - `gemini-cli`  → cliente histórico del Gemini CLI. **Google lo retiró**:
 *    `loadCodeAssist`/`onboardUser` responden `UNSUPPORTED_CLIENT` y no hay
 *    projectId, así que ya no sirve. Se conserva por compatibilidad.
 *  - `antigravity` → cliente del IDE Antigravity, que es el camino al que Google
 *    remite en ese mismo error. Mismos endpoints de Google, otro client_id,
 *    otro host de transporte (`daily-cloudcode-pa`) y otras cabeceras.
 *
 * Copiado de 9Router (`src/lib/oauth/providers/{gemini-cli,antigravity}.js` y
 * `open-sse/providers/shared.js`).
 *
 * AVISO DE CUOTA: Code Assist NO comparte cuota con el plan Pro de la app Gemini
 * ni con el nivel gratuito de AI Studio, y cada proveedor cuenta lo suyo.
 */

export interface OauthProviderConfig {
  id: 'gemini-cli' | 'antigravity';
  label: string;
  /** Valor de api_keys.platform. */
  platform: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  loadCodeAssistUrl: string;
  onboardUrl: string;
  /** Cuerpo del loadCodeAssist (antigravity no manda `mode`). */
  loadBody: () => Record<string, unknown>;
  /** Cabeceras propias de cada cliente para las llamadas de Code Assist. */
  loadHeaders: (accessToken: string) => Record<string, string>;
  /** Metadata de cliente que espera el IDE (ideType 9, platform, pluginType 2). */
  metadata: () => Record<string, unknown>;
  /** Tarifa sobre la que se hace el alta si `allowedTiers` no dice otra. */
  defaultTier: string;
  ua: string;
}

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v1/userinfo';
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function clientMetadata(): Record<string, unknown> {
  return { ideType: 9, platform: 5, pluginType: 2 };
}

export const OAUTH_PROVIDERS: Record<'gemini-cli' | 'antigravity', OauthProviderConfig> = {
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI (retirado por Google)',
    platform: 'gemini-cli',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    // El secreto NO vive en el repo (GitHub Push Protection lo bloquea, con
    // razón): se lee del entorno del servidor. El client_id es público.
    clientSecret: process.env.GEMINI_OAUTH_CLIENT_SECRET ?? '',
    scopes: SCOPES,
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    userInfoUrl: GOOGLE_USERINFO,
    loadCodeAssistUrl: `${CODE_ASSIST}:loadCodeAssist`,
    onboardUrl: `${CODE_ASSIST}:onboardUser`,
    loadBody: () => ({ metadata: clientMetadata(), mode: 1 }),
    loadHeaders: accessToken => ({
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'Client-Metadata': JSON.stringify(clientMetadata()),
    }),
    metadata: clientMetadata,
    defaultTier: 'free-tier',
    ua: 'google-api-nodejs-client/9.15.1',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity (Code Assist)',
    platform: 'antigravity',
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET ?? '',
    scopes: SCOPES,
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    userInfoUrl: GOOGLE_USERINFO,
    loadCodeAssistUrl: `${CODE_ASSIST}:loadCodeAssist`,
    onboardUrl: `${CODE_ASSIST}:onboardUser`,
    // El IDE no manda `mode`; sí manda `x-request-source: local`.
    loadBody: () => ({ metadata: clientMetadata() }),
    loadHeaders: accessToken => ({
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/ide/2.1.1 darwin/arm64',
      'x-request-source': 'local',
    }),
    metadata: clientMetadata,
    defaultTier: 'legacy-tier',
    ua: 'antigravity/ide/2.1.1 darwin/arm64',
  },
};

const STATE_PREFIX = 'oauth_state:';
const STATE_TTL_MS = 15 * 60 * 1000;
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface GeminiOauthSecret {
  accessToken: string;
  refreshToken: string;
  expiry: number;
  scope?: string;
  projectId?: string;
  email?: string;
  tierId?: string;
}

export interface OauthKeyRow {
  id: number;
  platform: string;
  kind?: string | null;
  oauth_provider?: string | null;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

export function isOauthKey(row: { kind?: string | null }): boolean {
  return row.kind === 'oauth';
}

export function providerConfig(id: string | null | undefined): OauthProviderConfig {
  return OAUTH_PROVIDERS[(id as 'antigravity') === 'antigravity' ? 'antigravity' : 'gemini-cli'];
}

export function clientMetadataJson(): string {
  return JSON.stringify(clientMetadata());
}

export function defaultRedirectUri(): string {
  const fromEnv = process.env.GEMINI_OAUTH_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  const port = process.env.PORT?.trim() || '20130';
  return `http://127.0.0.1:${port}/api/oauth/gemini/callback`;
}

function requireClientSecret(config: OauthProviderConfig): string {
  if (!config.clientSecret) {
    throw new Error(
      `Falta el secreto OAuth de ${config.id} en el entorno del servidor ` +
      `(${config.id === 'antigravity' ? 'ANTIGRAVITY_OAUTH_CLIENT_SECRET' : 'GEMINI_OAUTH_CLIENT_SECRET'}). ` +
      'No se guarda en el repo a propósito.',
    );
  }
  return config.clientSecret;
}

export function buildAuthUrl(config: OauthProviderConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: config.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

export function issueState(providerId: string, redirectUri: string): string {
  const state = randomBytes(16).toString('hex');
  setSetting(`${STATE_PREFIX}${state}`, JSON.stringify({ providerId, redirectUri, createdAt: Date.now() }));
  return state;
}

export function consumeState(state: string): { providerId: string; redirectUri: string } | null {
  const key = `${STATE_PREFIX}${state}`;
  const raw = getSetting(key);
  if (!raw) return null;
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  try {
    const parsed = JSON.parse(raw) as { providerId?: string; redirectUri?: string; createdAt?: number };
    if (!parsed.redirectUri || typeof parsed.createdAt !== 'number') return null;
    if (Date.now() - parsed.createdAt > STATE_TTL_MS) return null;
    return { providerId: parsed.providerId ?? 'gemini-cli', redirectUri: parsed.redirectUri };
  } catch {
    return null;
  }
}

export async function exchangeCode(
  config: OauthProviderConfig,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: requireClientSecret(config),
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google rechazó el canje del código (HTTP ${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}

interface CodeAssistInfo {
  projectId: string;
  tierId: string;
  raw: string;
}

/** loadCodeAssist: devuelve projectId y la tarifa por defecto (o el motivo del bloqueo). */
export async function loadCodeAssist(config: OauthProviderConfig, accessToken: string): Promise<CodeAssistInfo> {
  const res = await fetch(config.loadCodeAssistUrl, {
    method: 'POST',
    headers: config.loadHeaders(accessToken),
    body: JSON.stringify(config.loadBody()),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`loadCodeAssist falló (HTTP ${res.status}): ${raw.slice(0, 400)}`);
  }
  let tierId = config.defaultTier;
  let projectId = '';
  try {
    const data = JSON.parse(raw) as {
      cloudaicompanionProject?: string | { id?: string };
      allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
      ineligibleTiers?: Array<{ reasonCode?: string; reasonMessage?: string }>;
    };
    projectId = typeof data.cloudaicompanionProject === 'string'
      ? data.cloudaicompanionProject.trim()
      : (data.cloudaicompanionProject?.id ?? '').trim();
    const preferred = (data.allowedTiers ?? []).find(tier => tier?.isDefault && tier?.id);
    if (preferred?.id) tierId = preferred.id.trim();
    const blocked = data.ineligibleTiers?.[0];
    if (!projectId && blocked?.reasonMessage) {
      throw new Error(`${blocked.reasonCode ?? 'INELIGIBLE'}: ${blocked.reasonMessage}`);
    }
  } catch (error) {
    if (error instanceof Error && /^(UNSUPPORTED_CLIENT|INELIGIBLE|[A-Z_]+):/.test(error.message)) throw error;
    // JSON raro: se sigue con lo que haya
  }
  return { projectId, tierId, raw };
}

/** Alta del proyecto/tarifa (onboardUser). Best-effort: se sondea hasta 10 veces. */
export async function onboardUser(config: OauthProviderConfig, accessToken: string, tierId: string): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    try {
      const res = await fetch(config.onboardUrl, {
        method: 'POST',
        headers: config.loadHeaders(accessToken),
        body: JSON.stringify({ tierId, metadata: config.metadata() }),
        signal: AbortSignal.timeout(40000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { done?: boolean };
      if (data?.done) return;
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

export async function fetchEmail(config: OauthProviderConfig, accessToken: string): Promise<string> {
  try {
    const res = await fetch(`${config.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const data = (await res.json()) as { email?: string };
    return typeof data.email === 'string' ? data.email : '';
  } catch {
    return '';
  }
}

export function saveOauthKey(config: OauthProviderConfig, secret: GeminiOauthSecret): { keyId: number; created: boolean } {
  const db = getDb();
  const enc = encrypt(JSON.stringify(secret));
  const label = secret.email ? `${config.label} · ${secret.email}` : config.label;
  const existing = db
    .prepare('SELECT id FROM api_keys WHERE platform = ? AND label = ?')
    .get(config.platform, label) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE api_keys
          SET encrypted_key = ?, iv = ?, auth_tag = ?, kind = 'oauth',
              oauth_provider = ?, enabled = 1, status = 'healthy',
              status_reason = NULL, last_checked_at = datetime('now')
        WHERE id = ?`,
    ).run(enc.encrypted, enc.iv, enc.authTag, config.id, existing.id);
    return { keyId: existing.id, created: false };
  }

  const info = db.prepare(
    `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, kind, oauth_provider, last_checked_at)
     VALUES (?, ?, ?, ?, ?, 'healthy', 1, 'oauth', ?, datetime('now'))`,
  ).run(config.platform, label, enc.encrypted, enc.iv, enc.authTag, config.id);
  return { keyId: Number(info.lastInsertRowid), created: true };
}

/**
 * Secreto listo para una llamada, SIN red (el router elige clave en una función
 * síncrona). El token lo mantiene fresco `refreshDueOauthKeys`.
 */
export function resolveKeySecret(row: OauthKeyRow): string {
  const raw = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  if (!isOauthKey(row)) return raw;

  let parsed: Partial<GeminiOauthSecret>;
  try {
    parsed = JSON.parse(raw) as Partial<GeminiOauthSecret>;
  } catch {
    throw new Error('clave OAuth ilegible (JSON corrupto)');
  }
  const accessToken = typeof parsed.accessToken === 'string' ? parsed.accessToken : '';
  if (!accessToken) throw new Error('clave OAuth sin access_token');
  if (typeof parsed.expiry === 'number' && parsed.expiry > 0 && parsed.expiry <= Date.now()) {
    throw new Error('access_token caducado (pendiente de refresco)');
  }
  return JSON.stringify({ accessToken, projectId: parsed.projectId ?? '' });
}

async function refreshToken(config: OauthProviderConfig, refreshTokenValue: string): Promise<{
  access_token: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}> {
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: requireClientSecret(config),
      refresh_token: refreshTokenValue,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`refresh_token rechazado (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as { access_token: string; expires_in?: number; scope?: string; refresh_token?: string };
}

export async function refreshOauthKey(keyId: number, force = false): Promise<boolean> {
  const db = getDb();
  const row = db
    .prepare("SELECT id, platform, kind, oauth_provider, encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?")
    .get(keyId) as OauthKeyRow | undefined;
  if (!row || row.kind !== 'oauth') return false;
  const config = providerConfig(row.oauth_provider);

  let secret: GeminiOauthSecret;
  try {
    secret = JSON.parse(decrypt(row.encrypted_key, row.iv, row.auth_tag)) as GeminiOauthSecret;
  } catch {
    setKeyAccessStatus(keyId, 'expired', 'clave OAuth ilegible; reconecta la cuenta');
    return false;
  }

  if (!force && secret.expiry - Date.now() > REFRESH_MARGIN_MS) return true;
  if (!secret.refreshToken) {
    setKeyAccessStatus(keyId, 'expired', 'la cuenta no devolvió refresh_token; reconecta con consentimiento');
    return false;
  }

  try {
    const fresh = await refreshToken(config, secret.refreshToken);
    const next: GeminiOauthSecret = {
      ...secret,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token ?? secret.refreshToken,
      scope: fresh.scope ?? secret.scope,
      expiry: Date.now() + Math.max(60, fresh.expires_in ?? 3600) * 1000,
    };
    const enc = encrypt(JSON.stringify(next));
    db.prepare(
      `UPDATE api_keys SET encrypted_key = ?, iv = ?, auth_tag = ?, status = 'healthy',
              status_reason = NULL, last_checked_at = datetime('now')
        WHERE id = ?`,
    ).run(enc.encrypted, enc.iv, enc.authTag, keyId);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setKeyAccessStatus(keyId, 'expired', `no se pudo renovar el token: ${reason}`.slice(0, 400));
    return false;
  }
}

let lastSweep = 0;
const SWEEP_MIN_INTERVAL_MS = 60_000;

/** Refresca las claves OAuth dentro del margen (como mucho una vez por minuto). */
export async function refreshDueOauthKeys(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_MIN_INTERVAL_MS) return 0;
  lastSweep = now;
  const rows = getDb()
    .prepare("SELECT id FROM api_keys WHERE kind = 'oauth' AND enabled = 1 AND status IN ('healthy', 'unknown')")
    .all() as { id: number }[];
  let refreshed = 0;
  for (const row of rows) {
    if (await refreshOauthKey(row.id)) refreshed += 1;
  }
  return refreshed;
}
