/**
 * Auth & compliance middleware — Task T06.
 *
 * Exports:
 *   - `authenticate`       — verifies the JWT (HttpOnly cookie or Bearer header)
 *                            and attaches `req.user`.
 *   - `checkRole`          — RBAC guard; 403s principals outside the allowed set.
 *   - `hipaaAuditLogger`   — records an `AuditLog` row for every PHI-route access.
 *
 * Acceptance (matrix T06): blocks unauthorized roles; creates an AuditLog row in
 * the DB on PHI access.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AUTH_COOKIE } from './auth.router';
import type { AuthPrisma, AuthedUser, JwtPayload, UserRole } from './auth.types';
import { isUserRole } from './auth.types';

// Augment Express's Request with the authenticated principal.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/** Extract the raw JWT from the auth cookie or an `Authorization: Bearer` header. */
function extractToken(req: Request): string | undefined {
  // `req.cookies` is populated by cookie-parser (typed as any via @types/cookie-parser).
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const fromCookie = cookies?.[AUTH_COOKIE];
  if (fromCookie) return fromCookie;

  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return undefined;
}

function resolveSecret(explicit?: string): string {
  const secret = explicit ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return secret;
}

export interface AuthenticateOptions {
  jwtSecret?: string;
}

/**
 * Verify the request's JWT and populate `req.user`. Responds 401 when the token
 * is absent, malformed, expired, or fails signature verification.
 */
export function authenticate(options: AuthenticateOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const decoded = jwt.verify(token, resolveSecret(options.jwtSecret)) as JwtPayload;
      if (!decoded?.sub || !isUserRole(decoded.role)) {
        res.status(401).json({ error: 'InvalidToken' });
        return;
      }
      req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
      next();
    } catch {
      res.status(401).json({ error: 'InvalidToken' });
    }
  };
}

/**
 * RBAC guard. Accepts a single role or a list; must run after `authenticate`.
 * 401 if there is no authenticated principal, 403 if its role is not allowed.
 */
export function checkRole(allowedRoles: UserRole | readonly UserRole[]): RequestHandler {
  const allowed = new Set<UserRole>(
    Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles as UserRole],
  );
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (!allowed.has(user.role)) {
      res.status(403).json({ error: 'Forbidden', requiredRoles: [...allowed] });
      return;
    }
    next();
  };
}

/** Best-effort client IP for the audit trail. */
function clientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}

export interface HipaaAuditOptions {
  /** Prisma-like store. Defaults to the encryption-extended client (T04). */
  prisma?: AuthPrisma;
  /** Logical entity/resource type this route touches (e.g. 'Encounter'). */
  entityType: string;
  /** Override the recorded action. Defaults to the HTTP method. */
  action?: string;
  /** Request param name holding the entity id (default 'id'). */
  entityIdParam?: string;
}

/**
 * HIPAA access logger. Writes one `AuditLog` row per request to a PHI route,
 * capturing who accessed what, from where, and the response status. Logging
 * happens on response `finish` and never blocks or fails the request — a
 * failed audit write is reported to stderr, not surfaced to the caller.
 */
export function hipaaAuditLogger(options: HipaaAuditOptions): RequestHandler {
  const { entityType, action, entityIdParam = 'id' } = options;

  const getStore = async (): Promise<AuthPrisma> => {
    if (options.prisma) return options.prisma;
    const { getPrisma } = await import('@/shared/db/prisma');
    return getPrisma() as unknown as AuthPrisma;
  };

  return (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      const entry = {
        userId: req.user?.id ?? null,
        action: action ?? req.method,
        entityType,
        entityId: req.params?.[entityIdParam] ?? null,
        route: req.originalUrl,
        method: req.method,
        ipAddress: clientIp(req) ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: { statusCode: res.statusCode },
      };
      void getStore()
        .then((prisma) => prisma.auditLog.create({ data: entry }))
        .catch((err: unknown) => {
          // Never let an audit failure break the request path.
          console.error('[hipaaAuditLogger] failed to write AuditLog:', err);
        });
    });
    next();
  };
}
