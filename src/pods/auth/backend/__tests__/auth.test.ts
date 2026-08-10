/**
 * Tests for Task T05 — auth.router.ts (Vitest + Supertest).
 * Acceptance: POST /login returns 200 with a JWT cookie; rejects a bad password
 * with 401.
 */
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthRouter, AUTH_COOKIE } from '../auth.router';
import type { AuthPrisma, UserRecord } from '../auth.types';

const JWT_SECRET = 'test-secret-value-at-least-32-characters-long';

/** In-memory AuthPrisma fake — no database, no generated client. */
function makeStore(): AuthPrisma & { seedCount(): number } {
  const users = new Map<string, UserRecord>();
  let seq = 0;
  return {
    user: {
      async findUnique({ where }) {
        if (where.email !== undefined) {
          return [...users.values()].find((u) => u.email === where.email) ?? null;
        }
        if (where.id !== undefined) return users.get(where.id) ?? null;
        return null;
      },
      async create({ data }) {
        const id = `u${++seq}`;
        const rec: UserRecord = {
          id,
          email: String(data.email),
          passwordHash: String(data.passwordHash),
          firstName: (data.firstName as string | null) ?? null,
          lastName: (data.lastName as string | null) ?? null,
          role: (data.role as UserRecord['role']) ?? 'FRONT_DESK',
          isActive: true,
        };
        users.set(id, rec);
        return rec;
      },
      async update({ where, data }) {
        const rec = users.get(where.id);
        if (!rec) throw new Error('not found');
        Object.assign(rec, data);
        return rec;
      },
    },
    auditLog: { async create() { return {}; } },
    seedCount: () => users.size,
  };
}

function makeApp(store: AuthPrisma): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/auth', createAuthRouter({ prisma: store, jwtSecret: JWT_SECRET, secureCookies: false }));
  return app;
}

describe('auth.router (T05)', () => {
  let store: ReturnType<typeof makeStore>;
  let app: Express;

  beforeEach(() => {
    store = makeStore();
    app = makeApp(store);
  });

  const register = (body: Record<string, unknown>) =>
    request(app).post('/api/v1/auth/register').send(body);
  const login = (body: Record<string, unknown>) =>
    request(app).post('/api/v1/auth/login').send(body);

  it('registers a user and never returns the password/hash', async () => {
    const res = await register({
      email: 'doc@clinic.test',
      password: 'sup3r-secret-pw',
      role: 'PROVIDER',
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'doc@clinic.test', role: 'PROVIDER' });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('sup3r-secret-pw');

    // Stored hash must not equal the plaintext.
    const stored = await store.user.findUnique({ where: { email: 'doc@clinic.test' } });
    expect(stored?.passwordHash).toBeDefined();
    expect(stored?.passwordHash).not.toBe('sup3r-secret-pw');
  });

  it('rejects invalid registration bodies with 400', async () => {
    expect((await register({ email: 'nope', password: 'x' })).status).toBe(400);
    expect((await register({ email: 'a@b.test' })).status).toBe(400);
  });

  it('rejects a duplicate email with 409', async () => {
    await register({ email: 'dup@clinic.test', password: 'password123' });
    const res = await register({ email: 'dup@clinic.test', password: 'password123' });
    expect(res.status).toBe(409);
    expect(store.seedCount()).toBe(1);
  });

  it('logs in with valid credentials → 200 + HttpOnly JWT cookie', async () => {
    await register({ email: 'grace@clinic.test', password: 'password123', role: 'ADMIN' });
    const res = await login({ email: 'grace@clinic.test', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'grace@clinic.test', role: 'ADMIN' });
    // No token in the response body — it lives only in the cookie.
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/); // JWTs start with "eyJ"

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toBeDefined();
    const authCookie = cookies.find((c) => c.startsWith(`${AUTH_COOKIE}=`));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/HttpOnly/i);
    expect(authCookie).toMatch(/SameSite=Strict/i);
    expect(authCookie).toMatch(/eyJ/); // the JWT itself
  });

  it('rejects a wrong password with 401 and sets no cookie', async () => {
    await register({ email: 'user@clinic.test', password: 'correct-horse' });
    const res = await login({ email: 'user@clinic.test', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('InvalidCredentials');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an unknown user with 401 (no user enumeration)', async () => {
    const res = await login({ email: 'ghost@clinic.test', password: 'whatever123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('InvalidCredentials');
  });

  it('rejects an inactive user with 401', async () => {
    await register({ email: 'inactive@clinic.test', password: 'password123' });
    const u = await store.user.findUnique({ where: { email: 'inactive@clinic.test' } });
    await store.user.update({ where: { id: u!.id }, data: { isActive: false } });
    const res = await login({ email: 'inactive@clinic.test', password: 'password123' });
    expect(res.status).toBe(401);
  });

  it('logout clears the auth cookie', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const cleared = cookies.find((c) => c.startsWith(`${AUTH_COOKIE}=`));
    expect(cleared).toBeDefined();
    // Cleared cookie has an empty value / past expiry.
    expect(cleared).toMatch(new RegExp(`${AUTH_COOKIE}=;`));
  });
});
