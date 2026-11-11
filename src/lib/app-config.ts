/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "Restaurant Ordering";

export const APP_DESCRIPTION = "Part of the Breakthru Ventures 30 apps in 30 days portfolio.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/**
 * Header navigation. `show` lists who sees a link ("public" = signed out); hidden links are a convenience only:
 * every page still enforces its role on the server.
 */
export type NavAudience = "public" | "user" | "staff" | "admin";
export const NAV_LINKS: { href: string; label: string; show: readonly NavAudience[] }[] = [
  { href: "/menu", label: "Menu", show: ["public", "user", "admin"] },
  { href: "/cart", label: "Cart", show: ["user"] },
  { href: "/orders", label: "Orders", show: ["user"] },
  { href: "/kitchen", label: "Kitchen", show: ["staff"] },
  { href: "/kitchen/menu", label: "Menu editor", show: ["staff"] },
  { href: "/admin", label: "Admin", show: ["admin"] },
];
