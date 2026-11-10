/**
 * Role-based access control, kept as plain functions so it is easy to unit test
 * and impossible to bypass from the client: every server action and route
 * handler calls these before touching data.
 */

/** `user` is a customer. `staff` is restaurant staff (kitchen, menu). Exactly one role per account. */
export const ROLES = ["user", "staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

export type Actor = { id: string; role: Role };

export type Action = "read" | "create" | "update" | "delete";

/** A resource the actor may or may not own. */
export type Owned = { ownerId: string };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Better Auth's admin plugin can store comma-separated roles; return exactly one, the strongest
 * (admin, then staff, then user), so an account never holds two. Unknown names are `user`.
 */
export function toRole(value: string | null | undefined): Role {
  if (!value) return "user";
  const parts = value.split(",").map((p) => p.trim());
  if (parts.includes("admin")) return "admin";
  return parts.includes("staff") ? "staff" : "user";
}

/**
 * The template's ownership rule: admins pass everything. Orders and menu writes do NOT use it (admins see counts
 * only, and only staff edit the menu); those go through src/lib/access.ts.
 */
export function can(actor: Actor, action: Action, resource?: Owned): boolean {
  if (actor.role === "admin") return true;
  if (action === "create") return true;
  if (!resource) return false;
  return resource.ownerId === actor.id;
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Sign in to continue.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function assertCan(actor: Actor, action: Action, resource?: Owned): void {
  if (!can(actor, action, resource)) throw new ForbiddenError();
}
