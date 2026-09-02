import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OperationsSignInPage from "./[[...sign-in]]/page";

vi.mock("@clerk/nextjs", () => ({
  useSignIn: () => ({ isLoaded: true, signIn: {}, setActive: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

describe("staff sign-in page", () => {
  it("offers only staff sign-in and recovery, never signup", () => {
    render(<OperationsSignInPage />);

    expect(screen.getByRole("heading", { name: /operations sign in/i })).toBeTruthy();
    expect(screen.getByLabelText(/work email/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /forgot password/i })).toBeTruthy();
    expect(screen.queryByText(/sign up/i)).toBeNull();
  });
});
