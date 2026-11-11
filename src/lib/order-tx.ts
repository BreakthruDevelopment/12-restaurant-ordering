import "server-only";
import { db } from "@/lib/db";
import { orderBus, type OrderBusEvent } from "@/lib/order-bus";
import type { Tx } from "@/lib/usage";

const pending = new WeakMap<object, OrderBusEvent[]>();

/**
 * Queue a change on this transaction. Nothing is emitted until `transactionWithOrderEvents`
 * sees the transaction commit. Calling this and then throwing (or failing a statement) drops the event.
 */
export function enqueueOrderEvent(tx: object, event: OrderBusEvent): void {
  const list = pending.get(tx);
  if (list) list.push({ orderId: event.orderId, version: event.version, customerId: event.customerId });
  else pending.set(tx, [{ orderId: event.orderId, version: event.version, customerId: event.customerId }]);
}

/**
 * Run `fn` in a database transaction. Events queued on its `tx` are published only after commit.
 *
 * The queue is copied out of the callback and published only once `db().transaction` resolves,
 * which is after COMMIT. A throw rolls the transaction back and never reaches the publish loop,
 * so a listener cannot observe a change that did not stick, and cannot refetch a row that is not visible yet.
 */
export async function transactionWithOrderEvents<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await db().transaction(async (tx) => {
    const value = await fn(tx);
    const events = pending.get(tx) ?? [];
    pending.delete(tx);
    return { value, events };
  });
  for (const event of result.events) orderBus.publish(event);
  return result.value;
}
