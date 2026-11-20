import crypto from 'crypto';
import type { Request } from 'express';
import { getDb } from '../db/index.js';
import type { SessionUser } from '../services/auth.js';

/**
 * Core-under SSO: the Laravel panel is the only doorway to this dashboard and
 * it authenticates the operator itself. Instead of asking for a second password
 * inside the iframe, the reverse proxy (routes/web.php in the Laravel repo)
 * stamps a service token on every request it forwards, and this module turns
 * that token into the dashboard's own admin session.
 *
 * All three conditions must hold, otherwise the header is ignored:
 *   1. CORE_UNDER_SSO_TOKEN is set on this process and long enough to matter.
 *   2. The presented header matches it in constant time.
 *   3. The TCP peer is loopback — the gateway listens on 127.0.0.1 only, so the
 *      same-host proxy is the only possible caller.
 */
export const SSO_HEADER = 'x-core-under-sso';

const MIN_TOKEN_LENGTH = 32;

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopbackPeer(req: Request): boolean {
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  const addr = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return addr === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/** Was this request forwarded by the trusted Core-under proxy? */
export function ssoRequested(req: Request): boolean {
  const expected = (process.env.CORE_UNDER_SSO_TOKEN ?? '').trim();
  if (expected.length < MIN_TOKEN_LENGTH) return false;
  const presented = String(req.headers[SSO_HEADER] ?? '').trim();
  if (!presented || !constantTimeEquals(presented, expected)) return false;
  return isLoopbackPeer(req);
}

/**
 * The operator the proxy speaks for: the oldest dashboard account. Returns null
 * while the dashboard has no account yet, so the first-run setup flow survives.
 */
export function ssoSession(req: Request): SessionUser | null {
  if (!ssoRequested(req)) return null;
  const row = getDb()
    .prepare('SELECT id, email FROM users ORDER BY id ASC LIMIT 1')
    .get() as { id: number; email: string } | undefined;
  if (!row) return null;
  return { userId: row.id, email: row.email };
}
