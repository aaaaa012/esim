import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleActions } from "./lifecycle-actions";

const authFetch = vi.fn();
vi.mock("../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => authFetch,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const submit = screen.getByRole("button", { name: "Suspend connectivity" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(
      screen.getByPlaceholderText("Operational reason (required)"),
      { target: { value: "Customer reported device theft" } },
    );
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

  it("hides irreversible termination from non-super-admin operators", () => {
    render(
      <LifecycleActions
        orderId="order-1"
        iccid="8988247076000000319"
        providerStatus="ACTIVE"
        canTerminate={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Terminate" })).toBeNull();
  });
});
