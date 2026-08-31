import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OperationsSignInPage from "./[[...sign-in]]/page";

const signIn = vi.fn((_props: Record<string, unknown>) => (
  <div data-testid="clerk-sign-in" />
));

vi.mock("@clerk/nextjs", () => ({
  SignIn: (props: Record<string, unknown>) => signIn(props),
}));

describe("staff sign-in pages", () => {
  beforeEach(() => signIn.mockClear());

  it("keeps Operations authentication in a non-transferable sign-in flow", () => {
    render(<OperationsSignInPage />);

    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/sign-in",
        routing: "path",
        fallbackRedirectUrl: "/",
        transferable: false,
        withSignUp: false,
      }),
    );
    expect(signIn.mock.calls[0]?.[0]).not.toHaveProperty("forceRedirectUrl");
    expect(screen.queryByText(/sign in as super admin/i)).toBeNull();
  });
});
