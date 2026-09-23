import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ManualReviewTracking from "./manual-review-tracking";

afterEach(cleanup);

it("shows a dedicated approval tracker with a private correction path", () => {
  render(
    <ManualReviewTracking
      orderNumber="VC-123"
      failureCode="MRZ_REVIEW_REQUIRED"
      traveler={{
        firstName: "Jane",
        middleName: "",
        surname: "Doe",
        dateOfBirth: "1990-01-01",
        passportNumber: "P1234567",
        passportExpiryDate: "2030-01-01",
        nationality: "NP",
      }}
    />,
  );

  expect(
    screen.getByRole("heading", {
      name: "Your documents are awaiting approval",
    }),
  ).toBeDefined();
  expect(screen.getByText(/couldn't reliably read/i)).toBeDefined();
  expect(screen.getByText("Payment after approval")).toBeDefined();
  expect(screen.getByText("Order #VC-123")).toBeDefined();
  fireEvent.click(screen.getByText("Review submitted identity details"));
  expect(screen.getByText("Jane Doe")).toBeDefined();
  expect(screen.getByText("P1234567")).toBeDefined();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("link", { name: /report an error/i })).toHaveProperty(
    "href",
    "mailto:support@visacompassnepal.com?subject=Correction%20needed%20for%20order%20VC-123",
  );
});
