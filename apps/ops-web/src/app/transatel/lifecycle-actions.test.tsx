import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleActions } from "./lifecycle-actions";

const authFetch = vi.fn();
vi.mock("../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => authFetch,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    onSelect?: () => void;
  }) => (
    <button role="menuitem" onClick={onSelect} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

describe("LifecycleActions", () => {
  beforeEach(() => authFetch.mockReset());

  it("requires a reason and typed confirmation before suspending", async () => {
    authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { state: "ACCEPTED" } }),
    });
    render(
      <LifecycleActions
        orderId="order-1"
        iccid="8988247076000000319"
        providerStatus="ACTIVE"
        canTerminate
      />,
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Pause mobile data/ }),
    );
    const submit = screen.getByRole("button", { name: "Confirm data pause" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Reason (required)"), {
      target: { value: "Customer reported device theft" },
    });
    fireEvent.change(screen.getByLabelText(/Type.*SUSPEND.*to confirm/), {
      target: { value: "SUSPEND" },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(authFetch).toHaveBeenCalledOnce());
    expect(authFetch.mock.calls[0]?.[0]).toContain(
      "/operations/transatel/orders/order-1/suspend",
    );
    expect(
      JSON.parse(String(authFetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ reason: "Customer reported device theft" });
  });

  it("hides irreversible termination from non-super-admin operators", async () => {
    render(
      <LifecycleActions
        orderId="order-1"
        iccid="8988247076000000319"
        providerStatus="ACTIVE"
        canTerminate={false}
      />,
    );
    expect(
      await screen.findByRole("menuitem", { name: /Pause mobile data/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: /Permanently end eSIM/ }),
    ).toBeNull();
  });
});
