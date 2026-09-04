import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OpsSidebar from "./ops-sidebar";

const authFetch = vi.fn();

vi.mock("./authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => authFetch,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/orders" }));

function profile(accountType: "OPERATIONS" | "SUPER_ADMIN") {
  return {
    email: `${accountType.toLowerCase()}@visa-compass.test`,
    accountType,
    effectiveCapabilities:
      accountType === "SUPER_ADMIN" ? ["admin:portal"] : [],
  };
}

async function renderFor(accountType: "OPERATIONS" | "SUPER_ADMIN") {
  authFetch.mockResolvedValueOnce({
    json: async () => ({ data: profile(accountType) }),
  });
  render(<OpsSidebar />);
  await waitFor(() =>
    expect(
      screen.getByText(`${accountType.toLowerCase()}@visa-compass.test`),
    ).toBeTruthy(),
  );
}

describe("OpsSidebar role-based navigation", () => {
  beforeEach(() => authFetch.mockReset());

  it("shows every operational menu to an Operations user and hides admin-only menus", async () => {
    await renderFor("OPERATIONS");

    for (const label of [
      "Home",
      "To-do list",
      "Attention queue",
      "Orders",
      "Customers",
      "eSIM stock",
      "Provider status",
      "Pending activations",
      "Homepage campaigns",
      "Partners",
      "Refunds",
      "Messages",
      "Logs",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("link", { name: "Partners" }).getAttribute("href")).toBe("/admin/partners-showcase");
    expect(screen.getByRole("link", { name: "Homepage campaigns" }).getAttribute("href")).toBe("/admin/homepage-campaigns");
    expect(
      screen.getByRole("link", { name: "Orders" }).getAttribute("href"),
    ).toBe("/orders");
  });

  it("adds Super Admin-only settings and partner menus without hiding operational menus", async () => {
    await renderFor("SUPER_ADMIN");

    expect(
      screen.getByRole("link", { name: "Settings" }).getAttribute("href"),
    ).toBe("/admin");
    expect(screen.getByRole("link", { name: "Partners" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Homepage campaigns" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Provider status" })).toBeTruthy();
  });
});
