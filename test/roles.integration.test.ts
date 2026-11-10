/**
 * The `staff` role, through Better Auth's admin plugin against a real Postgres (TEST_DATABASE_URL):
 * sign-up can't choose a role, only an admin grants `staff` (audited as `role.changed`), unknown roles and role
 * lists are refused, staffs get no admin-plugin powers, and `requireRole` is exact (admin is not a staff).
 * Better Auth's origin check is off under NODE_ENV=test, so requests need no Origin header.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";

const cookieJar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(cookieJar.cookie ? { cookie: cookieJar.cookie } : {}) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

describe.skipIf(!url)("staff role (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let handler: (req: Request) => Promise<Response>;
  let session: typeof import("@/lib/auth/session");
  let logSpy: ReturnType<typeof vi.spyOn>;
  let adminCookie: string;
  let staffCookie: string;
  let plainCookie: string;
  let plainId: string;
  let staffId: string;
  const email = (n: string) => `rl-${n}@test.local`;

  async function call(path: string, body: unknown, cookie?: string) {
    return handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  }
  async function signUp(name: string, extra: Record<string, unknown> = {}) {
    const res = await call("/sign-up/email", { name, email: email(name), password: PASSWORD, ...extra });
    return { res, id: res.status === 200 ? ((await res.json()) as { user: { id: string } }).user.id : null };
  }
  async function signIn(name: string) {
    const res = await call("/sign-in/email", { email: email(name), password: PASSWORD });
    expect(res.status).toBe(200);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  const roleOf = async (id: string) => (await sql`select role from "user" where id = ${id}`)[0].role as string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where email like 'rl-%@test.local'`;
    const { auth } = await import("@/lib/auth");
    handler = auth().handler;
    session = await import("@/lib/auth/session");
    const { log } = await import("@/lib/log");
    logSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const adminId = (await signUp("admin")).id!;
    plainId = (await signUp("plain")).id!;
    staffId = (await signUp("staff")).id!;
    await sql`update "user" set role = 'admin' where id = ${adminId}`;
    await sql`update "user" set role = 'staff' where id = ${staffId}`;
    adminCookie = await signIn("admin");
    staffCookie = await signIn("staff");
    plainCookie = await signIn("plain");
  });
  afterAll(async () => {
    logSpy.mockRestore();
    await sql`delete from "user" where email like 'rl-%@test.local'`;
    await sql.end();
  });
  beforeEach(() => {
    logSpy.mockClear();
    cookieJar.cookie = "";
  });

  it("sign-up stays a customer even when the body says role: staff or admin", async () => {
    for (const [i, role] of (["staff", "admin", ["admin"]] as const).entries()) {
      const { res, id } = await signUp(`sneaky${i}`, { role });
      // Better Auth either ignores the field or refuses the request; either way no account gets the role.
      if (res.status === 200) expect(await roleOf(id!)).toBe("user");
      else expect(await sql`select 1 from "user" where email = ${email(`sneaky${i}`)}`).toHaveLength(0);
    }
  });

  it("sign-up can't smuggle a role through data either", async () => {
    const { id } = await signUp("sneaky-data", { data: { role: "admin" }, additionalFields: { role: "admin" } });
    if (id) expect(await roleOf(id)).toBe("user");
  });

  it("a customer or a staff member can't change anyone's role", async () => {
    for (const cookie of [plainCookie, staffCookie]) {
      const res = await call("/admin/set-role", { userId: plainId, role: "staff" }, cookie);
      expect(res.status).toBe(403);
    }
    expect(await roleOf(plainId)).toBe("user");
    expect(logSpy).not.toHaveBeenCalledWith("role.changed", expect.anything());
  });

  it("only an admin grants staff, and the grant is logged as role.changed with who, whom and what", async () => {
    const { id } = await signUp("grantee");
    const res = await call("/admin/set-role", { userId: id, role: "staff" }, adminCookie);
    expect(res.status).toBe(200);
    expect(await roleOf(id!)).toBe("staff");
    const adminId = (await sql`select id from "user" where email = ${email("admin")}`)[0].id;
    expect(logSpy).toHaveBeenCalledWith("role.changed", { by: adminId, userId: id, role: "staff", via: "/admin/set-role" });
    // And back down again.
    expect((await call("/admin/set-role", { userId: id, role: "user" }, adminCookie)).status).toBe(200);
    expect(await roleOf(id!)).toBe("user");
  });

  it("refuses an unknown role name and logs nothing", async () => {
    for (const role of ["underwriter", "superuser", "admin,staff", ""]) {
      const res = await call("/admin/set-role", { userId: plainId, role }, adminCookie);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await roleOf(plainId)).toBe("user");
    expect(logSpy).not.toHaveBeenCalledWith("role.changed", expect.anything());
  });

  it("refuses a role list, so one account never holds two roles (set-role, update-user, create-user)", async () => {
    let res = await call("/admin/set-role", { userId: plainId, role: ["admin", "staff"] }, adminCookie);
    expect(res.status).toBe(400);
    res = await call("/admin/update-user", { userId: plainId, data: { role: ["staff", "user"] } }, adminCookie);
    expect(res.status).toBe(400);
    res = await call("/admin/create-user", { email: email("listed"), name: "L", password: PASSWORD, role: ["staff", "admin"] }, adminCookie);
    expect(res.status).toBe(400);
    expect(await sql`select 1 from "user" where email = ${email("listed")}`).toHaveLength(0);
    expect(await roleOf(plainId)).toBe("user");
  });

  it("create-user and update-user set a single valid role, and each is logged as role.changed", async () => {
    const adminId = (await sql`select id from "user" where email = ${email("admin")}`)[0].id;
    const res = await call("/admin/create-user", { email: email("made"), name: "M", password: PASSWORD, role: "staff" }, adminCookie);
    expect(res.status).toBe(200);
    const madeId = ((await res.json()) as { user: { id: string } }).user.id;
    expect(await roleOf(madeId)).toBe("staff");
    expect(logSpy).toHaveBeenCalledWith("role.changed", { by: adminId, userId: madeId, role: "staff", via: "/admin/create-user" });

    logSpy.mockClear();
    const { id: target } = await signUp("updated");
    expect((await call("/admin/update-user", { userId: target, data: { role: "staff" } }, adminCookie)).status).toBe(200);
    expect(await roleOf(target!)).toBe("staff");
    expect(logSpy).toHaveBeenCalledWith("role.changed", { by: adminId, userId: target, role: "staff", via: "/admin/update-user" });

    // An update that sets no role is not a role change.
    logSpy.mockClear();
    expect((await call("/admin/update-user", { userId: target, data: { name: "Renamed" } }, adminCookie)).status).toBe(200);
    expect(logSpy).not.toHaveBeenCalledWith("role.changed", expect.anything());
  });

  it("unknown roles are refused on update-user and create-user too, with no change and no audit entry", async () => {
    for (const role of ["underwriter", "superuser", "admin,staff"]) {
      let res = await call("/admin/update-user", { userId: plainId, data: { role } }, adminCookie);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      res = await call("/admin/create-user", { email: email("unknown"), name: "U", password: PASSWORD, role }, adminCookie);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await roleOf(plainId)).toBe("user");
    expect(await sql`select 1 from "user" where email = ${email("unknown")}`).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalledWith("role.changed", expect.anything());
  });

  it("a signed-in user can't give themselves staff or admin through update-user (any shape)", async () => {
    for (const body of [{ role: "staff" }, { role: "admin" }, { data: { role: "staff" } }, { role: ["staff"] }, { name: "Plain", role: "staff" }]) {
      const res = await call("/update-user", body, plainCookie);
      // Better Auth drops fields that aren't user-settable or refuses the request; either way the role never changes.
      expect(res.status).toBeLessThan(500);
    }
    expect(await roleOf(plainId)).toBe("user");
    // Staff can't promote themselves to admin either.
    for (const body of [{ role: "admin" }, { data: { role: "admin" } }]) {
      expect((await call("/update-user", body, staffCookie)).status).toBeLessThan(500);
    }
    expect(await roleOf(staffId)).toBe("staff");
    expect(logSpy).not.toHaveBeenCalledWith("role.changed", expect.anything());
  });

  it("sign-up with role staff never yields staff, and the new account can't grant it to itself", async () => {
    const { res, id } = await signUp("sneaky-staff", { role: "staff" });
    if (res.status === 200) {
      expect(await roleOf(id!)).toBe("user");
      const cookie = await signIn("sneaky-staff");
      expect((await call("/admin/set-role", { userId: id, role: "staff" }, cookie)).status).toBe(403);
      expect(await roleOf(id!)).toBe("user");
    }
  });

  it("every grant and every revoke writes exactly one role.changed line, on every admin path", async () => {
    const adminId = (await sql`select id from "user" where email = ${email("admin")}`)[0].id;
    const { id } = await signUp("audited");
    logSpy.mockClear();
    expect((await call("/admin/set-role", { userId: id, role: "staff" }, adminCookie)).status).toBe(200);
    expect((await call("/admin/set-role", { userId: id, role: "user" }, adminCookie)).status).toBe(200);
    expect((await call("/admin/update-user", { userId: id, data: { role: "staff" } }, adminCookie)).status).toBe(200);
    const created = await call("/admin/create-user", { email: email("audited2"), name: "A2", password: PASSWORD, role: "staff" }, adminCookie);
    expect(created.status).toBe(200);
    const calls = logSpy.mock.calls.filter(([msg]: unknown[]) => msg === "role.changed");
    expect(calls).toHaveLength(4);
    for (const [, fields] of calls) expect(fields).toMatchObject({ by: adminId });
    expect(calls.map(([, f]: unknown[]) => (f as { via: string }).via)).toEqual(["/admin/set-role", "/admin/set-role", "/admin/update-user", "/admin/create-user"]);
  });

  it("the grant line carries ids and the role only, no email, name or password", async () => {
    const { id } = await signUp("lean");
    logSpy.mockClear();
    await call("/admin/set-role", { userId: id, role: "staff" }, adminCookie);
    const [[, fields]] = logSpy.mock.calls.filter(([msg]: unknown[]) => msg === "role.changed");
    expect(Object.keys(fields as object).sort()).toEqual(["by", "role", "userId", "via"]);
  });

  it("staff hold no admin-plugin permission at all", async () => {
    for (const [path, body] of [
      ["/admin/has-permission", { permissions: { user: ["set-role"] } }],
      ["/admin/has-permission", { permissions: { user: ["list"] } }],
      ["/admin/has-permission", { permissions: { user: ["ban"] } }],
      ["/admin/has-permission", { permissions: { session: ["revoke"] } }],
    ] as const) {
      const res = await call(path, body, staffCookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { success: boolean }).success).toBe(false);
    }
    for (const path of ["/admin/ban-user", "/admin/remove-user", "/admin/set-role"]) {
      expect((await call(path, { userId: plainId, role: "staff" }, staffCookie)).status).toBe(403);
    }
    const list = await handler(new Request("http://localhost:3000/api/auth/admin/list-users", { headers: { cookie: staffCookie } }));
    expect(list.status).toBe(403);
  });

  it("the signed-in user's role is read as exactly one of user, staff, admin", async () => {
    cookieJar.cookie = plainCookie;
    expect((await session.requireUser()).role).toBe("user");
    cookieJar.cookie = staffCookie;
    expect((await session.requireUser()).role).toBe("staff");
    cookieJar.cookie = adminCookie;
    expect((await session.requireUser()).role).toBe("admin");
  });

  it("requireRole is exact: admin is not staff, staff is not admin, a customer is neither", async () => {
    const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
    cookieJar.cookie = staffCookie;
    await expect(session.requireRole("staff")).resolves.toMatchObject({ role: "staff" });
    await expect(session.requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    cookieJar.cookie = adminCookie;
    await expect(session.requireRole("admin")).resolves.toMatchObject({ role: "admin" });
    await expect(session.requireRole("staff")).rejects.toBeInstanceOf(ForbiddenError);
    cookieJar.cookie = plainCookie;
    await expect(session.requireRole("staff")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(session.requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    cookieJar.cookie = "";
    await expect(session.requireRole("staff")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("pages send a signed-in user without the role to their own home", async () => {
    cookieJar.cookie = plainCookie;
    await expect(session.requireRoleOrRedirect("staff")).rejects.toThrow("REDIRECT:/dashboard");
    cookieJar.cookie = adminCookie;
    await expect(session.requireRoleOrRedirect("staff")).rejects.toThrow("REDIRECT:/admin");
    cookieJar.cookie = staffCookie;
    await expect(session.requireRoleOrRedirect("admin")).rejects.toThrow("REDIRECT:/dashboard");
    await expect(session.requireRoleOrRedirect("staff")).resolves.toMatchObject({ role: "staff" });
    cookieJar.cookie = "";
    await expect(session.requireUserOrRedirect()).rejects.toThrow("REDIRECT:/sign-in");
  });

  it("a banned staff member is signed out (no role, no session)", async () => {
    const { id } = await signUp("banned-staff");
    await sql`update "user" set role = 'staff' where id = ${id}`;
    const cookie = await signIn("banned-staff");
    cookieJar.cookie = cookie;
    await expect(session.requireRole("staff")).resolves.toBeTruthy();
    await sql`update "user" set banned = true where id = ${id}`;
    await expect(session.requireRole("staff")).rejects.toThrow();
  });

  it("public sign-up can't take a demo address or the demo marker", async () => {
    const res = await call("/sign-up/email", { name: "Fake", email: "casey@demo.breakthru.test", password: PASSWORD });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await sql`select 1 from "user" where email = 'casey@demo.breakthru.test' and image is not null`).toHaveLength(0);
    const res2 = await call("/sign-up/email", { name: "Fake", email: email("marker"), password: PASSWORD, image: "urn:breakthru:restaurant-demo:v1" });
    expect(res2.status).toBeGreaterThanOrEqual(400);
  });
});
