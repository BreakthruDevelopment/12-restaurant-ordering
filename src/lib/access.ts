import { type SQL, and, eq } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { order } from "@/lib/db/schema";

/**
 * Who may see and do what, in one place. The template's `can()` (admin passes everything) is deliberately not used.
 *
 * | Actor    | Orders (and their allergy details)        | Menu, allergen declarations, sold-out, settings | Counts |
 * | -------- | ----------------------------------------- | ----------------------------------------------- | ------ |
 * | public   | nothing                                   | read the public menu                            | no     |
 * | customer | their own orders; place; cancel `placed`  | read the public menu                            | no     |
 * | staff    | every order; acknowledge alerts; move it  | edit                                            | no     |
 * | admin    | nothing: order functions answer 404       | nothing: 403 (read the public menu)             | yes    |
 *
 * Every order function starts with `orderAccess(actor)` and puts `orderScope()` in its SQL, so a customer's query
 * can't match another customer's row; the filter runs in the database, not after it.
 */
export type OrderAccess = { kind: "customer"; customerId: string } | { kind: "staff"; staffId: string };

/** Customers and staff get order access. Admins get 404: the answer a stranger would get for a missing row. */
export function orderAccess(actor: Actor): OrderAccess {
  if (actor.role === "user") return { kind: "customer", customerId: actor.id };
  if (actor.role === "staff") return { kind: "staff", staffId: actor.id };
  throw new NotFoundError();
}

/** Rows of `order` the actor may touch. Customers: their own. Staff: all. */
export function orderScope(access: OrderAccess): SQL {
  return access.kind === "customer" ? eq(order.customerId, access.customerId) : (and() as SQL);
}

export function assertCustomer(actor: Actor): void {
  if (actor.role !== "user") throw new ForbiddenError("Only customers can do that.");
}

export function assertStaff(actor: Actor): void {
  if (actor.role !== "staff") throw new ForbiddenError("Only restaurant staff can do that.");
}

export function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw new ForbiddenError("Only administrators can do that.");
}

/**
 * The menu assistant answers questions about the public menu and stores nothing, so any signed-in account may ask
 * (customers, staff and admins). Anonymous visitors are stopped earlier, by `requireUser()`; an unknown role is refused here.
 */
export function assertCanAskAssistant(actor: Actor): void {
  if (actor.role !== "user" && actor.role !== "staff" && actor.role !== "admin") throw new ForbiddenError("Sign in to ask the menu assistant.");
}
