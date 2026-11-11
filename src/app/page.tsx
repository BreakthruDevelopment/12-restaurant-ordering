import type { Metadata } from "next";
import { MenuPage } from "./menu/menu-page";

export const metadata: Metadata = { title: "Menu" };
export const dynamic = "force-dynamic";

/** The home page is the public menu (spec: `/` and `/menu`). */
export default function Home() {
  return <MenuPage />;
}
