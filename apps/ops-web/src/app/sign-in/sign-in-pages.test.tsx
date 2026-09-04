import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OperationsSignInPage from "./[[...sign-in]]/page";
import { clerkAuthMessage } from "./staff-sign-in";

vi.mock("@clerk/nextjs", () => ({
  useSignIn: () => ({ isLoaded: true, signIn: {}, setActive: vi.fn() }),
  useAuth: () => ({ isLoaded: true, isSignedIn: false, getToken: vi.fn() }),
  useClerk: () => ({ signOut: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe("staff sign-in page", () => {
  it("offers only staff sign-in and recovery, never signup", () => {
    render(<OperationsSignInPage />);

    expect(
      screen.getByRole("heading", { name: /operations sign in/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/work email/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /forgot password/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/sign up/i)).toBeNull();
  });

  it("maps Clerk failures to approved application copy", () => {
    const providerText = "Clerk request failed: secret configuration detail";
    expect(
      clerkAuthMessage(
        { errors: [{ code: "unexpected_error", longMessage: providerText }] },
        "Unable to sign in.",
      ),
    ).toBe("Unable to sign in.");
    expect(
      clerkAuthMessage(
        { errors: [{ code: "form_password_incorrect" }] },
        "Unable to sign in.",
      ),
    ).toBe("The email or password is incorrect.");
  });
});
