import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  OAUTH_PROVIDERS,
  buildAuthUrl,
  consumeState,
  defaultRedirectUri,
  exchangeCode,
  fetchEmail,
  issueState,
  loadCodeAssist,
  onboardUser,
  providerConfig,
  refreshOauthKey,
  saveOauthKey,
  type GeminiOauthSecret,
  type OauthProviderConfig,
} from '../services/gemini-oauth.js';

/**
 * Conexión de una cuenta Google (Code Assist) desde el panel.
 *
 * `:provider` es `gemini` (cliente histórico, ya retirado por Google) o
 * `antigravity` (el que Google indica como sustituto).
 *
 * El callback TIENE que ser público: lo llama el navegador del usuario al volver
 * de Google, sin sesión del panel. El gateway sólo escucha en 127.0.0.1 y el
 * único camino desde fuera es el proxy autenticado de Laravel.
 */
export const oauthRouter = Router();

function configFor(param: string): OauthProviderConfig {
  return param === 'antigravity' ? OAUTH_PROVIDERS.antigravity : OAUTH_PROVIDERS['gemini-cli'];
}

function redirectFrom(req: Request): string {
  const raw = typeof req.query.redirectUri === 'string' ? req.query.redirectUri.trim() : '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return defaultRedirectUri();
}

oauthRouter.get('/:provider/start', (req: Request, res: Response) => {
  const config = configFor(req.params.provider);
  const redirectUri = redirectFrom(req);
  const state = issueState(config.id, redirectUri);
  res.json({
    provider: config.id,
    label: config.label,
    state,
    redirectUri,
    url: buildAuthUrl(config, redirectUri, state),
    hint: 'Si la pestaña no vuelve sola, copia el parámetro code de la barra de direcciones y pégalo en el panel.',
  });
});

interface FinishResult {
  keyId: number;
  created: boolean;
  provider: string;
  email: string;
  projectId: string;
  tierId: string;
  expiry: string;
}

async function finishConnection(code: string, state: string): Promise<FinishResult> {
  const pending = consumeState(state);
  if (!pending) throw new Error('state inválido o caducado: vuelve a pulsar «Conectar cuenta Google»');
  if (!code.trim()) throw new Error('falta el código de autorización');

  const config = providerConfig(pending.providerId);
  const tokens = await exchangeCode(config, code.trim(), pending.redirectUri);
  if (!tokens.access_token) throw new Error('Google no devolvió access_token');

  const [email, assist] = await Promise.all([
    fetchEmail(config, tokens.access_token),
    // Si Google rechaza el cliente, aquí se ve el motivo exacto (UNSUPPORTED_CLIENT…).
    loadCodeAssist(config, tokens.access_token),
  ]);

  if (!assist.projectId) {
    // Cuenta sin proyecto: se intenta el alta y se relee. Si sigue vacío, el
    // token no sirve para llamar y se guarda igualmente con el motivo.
    await onboardUser(config, tokens.access_token, assist.tierId).catch(() => undefined);
    const retry = await loadCodeAssist(config, tokens.access_token).catch(() => null);
    if (retry?.projectId) {
      assist.projectId = retry.projectId;
      assist.tierId = retry.tierId;
    }
  }

  const secret: GeminiOauthSecret = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiry: Date.now() + Math.max(60, tokens.expires_in ?? 3600) * 1000,
    scope: tokens.scope,
    projectId: assist.projectId,
    email,
    tierId: assist.tierId,
  };
  const saved = saveOauthKey(config, secret);
  return {
    keyId: saved.keyId,
    created: saved.created,
    provider: config.id,
    email,
    projectId: assist.projectId,
    tierId: assist.tierId,
    expiry: new Date(secret.expiry).toISOString(),
  };
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0}
section{max-width:480px;padding:24px;border:1px solid #2a2f3a;border-radius:14px;background:#12151c}
h1{font-size:16px;margin:0 0 8px}p{font-size:13px;color:#a7adba;margin:4px 0}code{color:#7ee787}</style></head>
<body><section><h1>${title}</h1>${body}</section></body></html>`;
}

oauthRouter.get('/:provider/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  if (error) {
    res.status(400).send(htmlPage('No se autorizó la cuenta', `<p>Google devolvió: <code>${error}</code></p><p>Ya puedes cerrar esta pestaña.</p>`));
    return;
  }
  try {
    const result = await finishConnection(code, state);
    res.send(htmlPage(
      'Cuenta Google conectada',
      `<p>Clave <code>#${result.keyId}</code> guardada como <code>${result.provider}</code>.</p>` +
      `<p>Cuenta: <code>${result.email || 'sin email'}</code> · proyecto: <code>${result.projectId || 'sin projectId'}</code> · tarifa: <code>${result.tierId}</code></p>` +
      '<p>Ya puedes cerrar esta pestaña y volver al panel.</p>',
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).send(htmlPage('No se pudo conectar', `<p>${message}</p><p>Vuelve al panel e inténtalo de nuevo.</p>`));
  }
});

oauthRouter.post('/:provider/complete', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';
  const state = typeof body.state === 'string' ? body.state : '';
  try {
    const result = await finishConnection(code, state);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({
      error: { message: err instanceof Error ? err.message : String(err), type: 'oauth_failed' },
    });
  }
});

oauthRouter.post('/:provider/:id/refresh', async (req: Request, res: Response) => {
  const keyId = Number(req.params.id);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    res.status(400).json({ error: { message: 'id invalido', type: 'invalid_request' } });
    return;
  }
  const ok = await refreshOauthKey(keyId, true);
  res.status(ok ? 200 : 409).json({ keyId, refreshed: ok });
});
