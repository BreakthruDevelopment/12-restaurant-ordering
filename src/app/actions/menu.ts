"use server";

import { type ActionResult, runAction } from "@/lib/action-result";
import { requireRole } from "@/lib/auth/session";
import { archiveItem, createCategory, createItem, setAllergens, setSoldOut, updateItem, updateSettings } from "@/lib/menu";

/**
 * Menu editor and kitchen settings. Every action is staff only (requireRole("staff")) and goes through the existing
 * data functions, which validate with zod, rate limit and write the allergen change log.
 */

export async function createCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => ({ id: (await createCategory(await requireRole("staff"), input)).id }));
}

export async function createItemAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => ({ id: (await createItem(await requireRole("staff"), input)).id }));
}

export async function updateItemAction(itemId: string, input: unknown): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => ({ version: (await updateItem(await requireRole("staff"), itemId, input)).version }));
}

export async function setAllergensAction(itemId: string, input: unknown): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => ({ version: (await setAllergens(await requireRole("staff"), itemId, input)).version }));
}

export async function setSoldOutAction(itemId: string, soldOut: boolean): Promise<ActionResult<{ soldOut: boolean }>> {
  return runAction(async () => ({ soldOut: (await setSoldOut(await requireRole("staff"), itemId, { soldOut })).soldOut }));
}

export async function archiveItemAction(itemId: string): Promise<ActionResult<null>> {
  return runAction(async () => {
    await archiveItem(await requireRole("staff"), itemId);
    return null;
  });
}

export async function updateSettingsAction(input: unknown): Promise<ActionResult<{ acceptingOrders: boolean; pickupMinutes: number }>> {
  return runAction(async () => {
    const s = await updateSettings(await requireRole("staff"), input);
    return { acceptingOrders: s.acceptingOrders, pickupMinutes: s.pickupMinutes };
  });
}
