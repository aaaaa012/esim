import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ManualReviewTracking from "./manual-review-tracking";

afterEach(cleanup);

it("shows a read-only identity summary and a clear next step", () => {
  const onBack = vi.fn();
  render(
    <ManualReviewTracking
      traveler={{
        firstName: "Jane",
        middleName: "",
        surname: "Doe",
        dateOfBirth: "1990-01-01",
        passportNumber: "P1234567",
        passportExpiryDate: "2030-01-01",
        nationality: "NP",
      }}
      onBack={onBack}
    />,
  );

  expect(
    screen.getByRole("heading", { name: "Review in progress" }),
  ).toBeDefined();
  expect(screen.getByText("Jane Doe")).toBeDefined();
  expect(screen.getByText("P1234567")).toBeDefined();
  expect(screen.getByText(/identity details are read-only/i)).toBeDefined();
  expect(screen.queryByRole("textbox")).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "View uploaded documents" }),
  );
  expect(onBack).toHaveBeenCalledOnce();
});
