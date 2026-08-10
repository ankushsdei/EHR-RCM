/**
 * Shared auth-pod types — Tasks T05 / T06.
 *
 * `UserRole` mirrors the Prisma `UserRole` enum in prisma/schema.prisma. It is
 * redeclared here (rather than imported from the generated `@prisma/client`) so
 * the auth pod compiles and unit-tests without a generated client — which the
 * CI sandbox cannot produce (Prisma engine download is blocked).
 */

export const USER_ROLES = [
  'ADMIN',
  'PROVIDER',
  'CLINICIAN',
  'FRONT_DESK',
  'BILLER',
  'PATIENT',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** Decoded JWT payload stored in the HttpOnly auth cookie. */
export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: UserRole;
}

/** The authenticated principal attached to `req.user` by `authenticate`. */
export interface AuthedUser {
  id: string;
  email: string;
  role: UserRole;
}

/** Shape of a persisted user row the auth pod relies on. */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  isActive: boolean;
}

/**
 * Minimal structural subset of the Prisma client the auth pod uses. Declaring
 * it explicitly lets tests inject a lightweight fake and keeps the pod
 * decoupled from the (ungenerated) full client type.
 */
export interface AuthPrisma {
  user: {
    findUnique(args: {
      where: { email?: string; id?: string };
    }): Promise<UserRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<UserRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<UserRecord>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}
