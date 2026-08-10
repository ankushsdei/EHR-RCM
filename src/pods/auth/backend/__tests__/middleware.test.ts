/**
 * Tests for Task T06 — auth.middleware.ts (Vitest + Supertest).
 * Acceptance: blocks unauthorized roles; creates an AuditLog row on PHI access.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { authenticate, checkRole, hipaaAuditLogger } from '../auth.middleware';
import { AUTH_COOKIE } from '../auth.router';
import type { AuthPrisma, AuthedUser, JwtPayload, UserRole } from '../auth.types';

const JWT_SECRET = 'test-secret-value-at-least-32-characters-long';

/** Middleware that injects a fixed principal (stands in for `authenticate`). */
function asUser(user: AuthedUser | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  };
}

const sign = (payload: JwtPayload) => jwt.sign(payload, JWT_SECRET, { expiresIn: 3600 });

const flush = () => new Promise((r) => setImmediate(r));

describe('authenticate (T06)', () => {
  const app = express();
  app.use(cookieParser());
  app.get('/me', authenticate({ jwtSecret: JWT_SECRET }), (req, res) => {
    res.json({ user: req.user });
  });

  it('accepts a valid Bearer token and populates req.user', async () => {
    const token = sign({ sub: 'u1', email: 'a@b.test', role: 'PROVIDER' });
    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 'u1', email: 'a@b.test', role: 'PROVIDER' });
  });

  it('accepts a valid auth cookie', async () => {
    const token = sign({ sub: 'u2', email: 'c@d.test', role: 'ADMIN' });
    const res = await request(app).get('/me').set('Cookie', `${AUTH_COOKIE}=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('u2');
  });

  it('401s when the token is missing', async () => {
    expect((await request(app).get('/me')).status).toBe(401);
  });

  it('401s when the token is invalid/forged', async () => {
    const forged = jwt.sign({ sub: 'x', email: 'e@f.test', role: 'ADMIN' }, 'wrong-secret');
    const res = await request(app).get('/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});

describe('checkRole (T06)', () => {
  function appFor(user: AuthedUser | undefined, allowed: UserRole | UserRole[]): Express {
    const app = express();
    app.get('/admin', asUser(user), checkRole(allowed), (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('allows a principal whose role is in the allowed set', async () => {
    const app = appFor({ id: 'u1', email: 'a@b.test', role: 'ADMIN' }, ['ADMIN', 'PROVIDER']);
    const res = await request(app).get('/admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('403s a principal whose role is not allowed', async () => {
    const app = appFor({ id: 'u2', email: 'p@b.test', role: 'PATIENT' }, ['ADMIN']);
    const res = await request(app).get('/admin');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('401s when there is no authenticated principal', async () => {
    const app = appFor(undefined, 'ADMIN');
    expect((await request(app).get('/admin')).status).toBe(401);
  });

  it('accepts a single role argument', async () => {
    const app = appFor({ id: 'u3', email: 'b@b.test', role: 'BILLER' }, 'BILLER');
    expect((await request(app).get('/admin')).status).toBe(200);
  });
});

describe('hipaaAuditLogger (T06)', () => {
  function makeApp(prisma: AuthPrisma, user?: AuthedUser): Express {
    const app = express();
    app.get(
      '/api/v1/encounters/:id',
      asUser(user),
      hipaaAuditLogger({ prisma, entityType: 'Encounter' }),
      (_req, res) => res.status(200).json({ id: _req.params.id }),
    );
    return app;
  }

  it('writes exactly one AuditLog row capturing who/what/where on PHI access', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { auditLog: { create } } as unknown as AuthPrisma;
    const app = makeApp(prisma, { id: 'clin-1', email: 'doc@clinic.test', role: 'CLINICIAN' });

    const res = await request(app)
      .get('/api/v1/encounters/enc-42')
      .set('User-Agent', 'vitest-agent');
    expect(res.status).toBe(200);

    await flush(); // let the res.on('finish') async write settle

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      userId: 'clin-1',
      entityType: 'Encounter',
      entityId: 'enc-42',
      method: 'GET',
      action: 'GET',
    });
    expect(String(data.route)).toContain('/api/v1/encounters/enc-42');
    expect(data.userAgent).toBe('vitest-agent');
    expect((data.metadata as { statusCode: number }).statusCode).toBe(200);
  });

  it('records a null userId for unauthenticated access but still logs', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { auditLog: { create } } as unknown as AuthPrisma;
    const app = makeApp(prisma);

    await request(app).get('/api/v1/encounters/enc-7');
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.userId).toBeNull();
    expect(data.entityId).toBe('enc-7');
  });

  it('does not break the request when the audit write fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prisma = { auditLog: { create } } as unknown as AuthPrisma;
    const app = makeApp(prisma, { id: 'u1', email: 'a@b.test', role: 'PROVIDER' });

    const res = await request(app).get('/api/v1/encounters/enc-9');
    await flush();

    expect(res.status).toBe(200); // request still succeeded
    expect(create).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
