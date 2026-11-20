import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

const SSO_TOKEN = 's'.repeat(48);

async function call(
  app: Express,
  method: string,
  path: string,
  opts: { body?: any; headers?: Record<string, string> } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// Core-under SSO: the Laravel panel authenticates the operator and its reverse
// proxy stamps x-core-under-sso on every forwarded request, so the dashboard
// never asks for a second password inside the iframe.
describe('Core-under proxy SSO', () => {
  let app: Express;
  const previousToken = process.env.CORE_UNDER_SSO_TOKEN;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.CORE_UNDER_SSO_TOKEN = SSO_TOKEN;
    initDb(':memory:');
    app = createApp();
    await call(app, 'POST', '/api/auth/setup', {
      body: { email: 'ops@core-under.local', password: 'pw-for-sso-test' },
    });
  });

  afterAll(() => {
    if (previousToken === undefined) delete process.env.CORE_UNDER_SSO_TOKEN;
    else process.env.CORE_UNDER_SSO_TOKEN = previousToken;
  });

  it('reports the proxied operator as authenticated', async () => {
    const { status, body } = await call(app, 'GET', '/api/auth/status', {
      headers: { 'x-core-under-sso': SSO_TOKEN },
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      needsSetup: false,
      authenticated: true,
      email: 'ops@core-under.local',
    });
  });

  it('unlocks the gated /api surface for that operator', async () => {
    const { status } = await call(app, 'GET', '/api/keys', {
      headers: { 'x-core-under-sso': SSO_TOKEN },
    });
    expect(status).toBe(200);
  });

  it('answers /api/auth/me with the proxied account', async () => {
    const { status, body } = await call(app, 'GET', '/api/auth/me', {
      headers: { 'x-core-under-sso': SSO_TOKEN },
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ email: 'ops@core-under.local' });
  });

  it('ignores a wrong token', async () => {
    expect((await call(app, 'GET', '/api/keys', { headers: { 'x-core-under-sso': 'nope' } })).status).toBe(401);
    const status = await call(app, 'GET', '/api/auth/status', { headers: { 'x-core-under-sso': 'nope' } });
    expect(status.body).toMatchObject({ authenticated: false });
  });

  it('ignores the header when no token is configured', async () => {
    delete process.env.CORE_UNDER_SSO_TOKEN;
    try {
      expect((await call(app, 'GET', '/api/keys', { headers: { 'x-core-under-sso': SSO_TOKEN } })).status).toBe(401);
    } finally {
      process.env.CORE_UNDER_SSO_TOKEN = SSO_TOKEN;
    }
  });
});
