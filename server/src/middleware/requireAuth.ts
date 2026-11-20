import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';
import { ssoSession } from '../lib/sso.js';

// Gate the /api/* admin surface behind a dashboard session (#35, item #2).
// The token is the opaque session token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer <token>`. The /v1 proxy is NOT gated by this — it
// keeps its own unified-API-key auth for app clients.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  // Core-under SSO first: when the Laravel panel forwards an operator it has
  // already authenticated, that proxy token IS the session.
  const session = ssoSession(req) ?? validateSession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  (req as Request & { user?: typeof session }).user = session;
  next();
}
