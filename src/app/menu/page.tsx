import type { Metadata } from "next";
import { MenuPage } from "./menu-page";

export const metadata: Metadata = { title: "Menu" };
export const dynamic = "force-dynamic";

export default function Page() {
  return <MenuPage />;
}
