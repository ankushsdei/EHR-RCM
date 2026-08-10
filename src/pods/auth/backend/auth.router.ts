/**
 * Auth router — Task T05.
 *
 * Express router exposing:
 *   - POST /api/v1/auth/register  — create a user (bcrypt-hashed password)
 *   - POST /api/v1/auth/login     — verify credentials, issue JWT cookie
 *   - POST /api/v1/auth/logout    — clear the auth cookie
 *
 * The JWT is stored in an HttpOnly, SameSite=strict cookie (never returned in
 * the body) so it is invisible to client-side JS and not sent cross-site.
 *
 * The Prisma client and JWT secret are injectable so the router can be tested
 * with a fake store and no live database / generated client.
 *
 * Acceptance (matrix T05): POST /login returns 200 with a JWT cookie; rejects a
 * bad password with 401.
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AuthPrisma, JwtPayload, UserRecord } from './auth.types';
import { USER_ROLES } from './auth.types';

/** Name of the HttpOnly cookie carrying the signed JWT. */
export const AUTH_COOKIE = 'access_token';

const BCRYPT_ROUNDS = 12;
const TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8h

/**
 * A valid bcrypt hash of a value no user can have. Compared against when the
 * account is missing/inactive so login timing does not reveal whether an email
 * exists (mitigates user-enumeration via response-time side channel).
 */
const DUMMY_HASH = '$2a$12$ucUNPnS4hgJUw92P1sSI4Ob.PpFbH1rIhoS1l4gKCdMc4dLs3Ucmq';

export interface AuthRouterDeps {
  /** Prisma-like store. Defaults to the encryption-extended client (T04). */
  prisma?: AuthPrisma;
  /** JWT signing secret. Defaults to process.env.JWT_SECRET. */
  jwtSecret?: string;
  /** Emit the `Secure` cookie attribute. Defaults to NODE_ENV === 'production'. */
  secureCookies?: boolean;
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'password must be at least 8 characters'),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(USER_ROLES).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Strip secrets before returning a user over the wire. */
function toPublicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
  };
}

function resolveSecret(deps: AuthRouterDeps): string {
  const secret = deps.jwtSecret ?? process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET is not configured (must be >= 32 chars)');
  }
  return secret;
}

function issueCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function createAuthRouter(deps: AuthRouterDeps = {}): Router {
  const router = Router();
  const secureCookies = deps.secureCookies ?? process.env.NODE_ENV === 'production';

  // Resolve the store lazily per request so importing this module never
  // constructs a PrismaClient (which requires a generated client).
  const getStore = async (): Promise<AuthPrisma> => {
    if (deps.prisma) return deps.prisma;
    const { getPrisma } = await import('@/shared/db/prisma');
    return getPrisma() as unknown as AuthPrisma;
  };

  router.post('/register', async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const { email, password, firstName, lastName, role } = parsed.data;
    const prisma = await getStore();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'EmailAlreadyRegistered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        ...(role ? { role } : {}),
      },
    });

    return res.status(201).json({ user: toPublicUser(user) });
  });

  router.post('/login', async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const { email, password } = parsed.data;
    const prisma = await getStore();

    const user = await prisma.user.findUnique({ where: { email } });
    // Use a uniform 401 whether the user is missing, inactive, or the password
    // is wrong — do not leak which accounts exist. Always run one bcrypt compare
    // (against a dummy hash when there is no usable account) to flatten timing.
    const hash = user && user.isActive ? user.passwordHash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);
    if (!user || !user.isActive || !ok) {
      return res.status(401).json({ error: 'InvalidCredentials' });
    }

    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, resolveSecret(deps), { expiresIn: TOKEN_TTL_SECONDS });
    issueCookie(res, token, secureCookies);

    return res.status(200).json({ user: toPublicUser(user) });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(AUTH_COOKIE, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies,
      path: '/',
    });
    return res.status(200).json({ ok: true });
  });

  return router;
}

export default createAuthRouter;
