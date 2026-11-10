import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { assertAdmin, assertCustomer, assertStaff, orderAccess } from "./access";

const customer = { id: "c1", role: "user" as const };
const staff = { id: "s1", role: "staff" as const };
const admin = { id: "a1", role: "admin" as const };

describe("orderAccess", () => {
  it("scopes customers to themselves and gives staff the kitchen", () => {
    expect(orderAccess(customer)).toEqual({ kind: "customer", customerId: "c1" });
    expect(orderAccess(staff)).toEqual({ kind: "staff", staffId: "s1" });
  });

  it("answers 404 for admins: they see counts, never orders", () => {
    expect(() => orderAccess(admin)).toThrow(NotFoundError);
  });
});

describe("role assertions are exact", () => {
  it("staff is not admin and admin is not staff", () => {
    expect(() => assertStaff(staff)).not.toThrow();
    expect(() => assertStaff(admin)).toThrow(ForbiddenError);
    expect(() => assertStaff(customer)).toThrow(ForbiddenError);
    expect(() => assertAdmin(admin)).not.toThrow();
    expect(() => assertAdmin(staff)).toThrow(ForbiddenError);
    expect(() => assertCustomer(customer)).not.toThrow();
    expect(() => assertCustomer(staff)).toThrow(ForbiddenError);
    expect(() => assertCustomer(admin)).toThrow(ForbiddenError);
  });
});
