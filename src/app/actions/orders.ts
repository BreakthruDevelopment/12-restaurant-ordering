"use server";

import { type ActionResult, runAction } from "@/lib/action-result";
import { requireRole, requireUser } from "@/lib/auth/session";
import { type OrderView, acknowledgeAllergy, placeOrder, transitionOrder } from "@/lib/orders";

/** Checkout. The data function validates the body with zod, ignores any price and enforces the allergy rules. */
export async function placeOrderAction(input: unknown): Promise<ActionResult<{ orderId: string; created: boolean }>> {
  return runAction(async () => {
    const { order, created } = await placeOrder(await requireUser(), input);
    return { orderId: order.id, created };
  });
}

/** Customer cancel (only while placed) and every staff move; access and the state machine are checked in transitionOrder(). */
export async function transitionOrderAction(orderId: string, input: unknown): Promise<ActionResult<OrderView>> {
  return runAction(async () => transitionOrder(await requireUser(), orderId, input));
}

/** "Allergy reviewed with kitchen" (staff only). */
export async function acknowledgeAllergyAction(orderId: string): Promise<ActionResult<OrderView>> {
  return runAction(async () => acknowledgeAllergy(await requireRole("staff"), orderId));
}
