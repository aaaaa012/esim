import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import PaymentJourneyConfirmation from "./post-payment-confirmation";

afterEach(cleanup);

it("shows a paid receipt without claiming the QR is ready during provisioning", () => {
  render(
    <PaymentJourneyConfirmation
      orderNumber="VC-123"
      amountNpr={652}
      status="PROVISIONING"
      trackingHref="/account/orders/123"
      trackingLabel="View order"
    />,
  );
  expect(screen.getByText("NPR 652")).toBeDefined();
  expect(screen.getByText("VC-123")).toBeDefined();
  expect(
    screen.getByText("Your installation details are on the way"),
  ).toBeDefined();
  expect(screen.queryByText(/QR sent to your email/i)).toBeNull();
  expect(
    screen.getByRole("link", { name: /View order/i }).getAttribute("href"),
  ).toBe("/account/orders/123");
  const timeline = screen.getByRole("list", { name: "Order progress" });
  expect(within(timeline).getByText("Preparing eSIM")).toBeDefined();
});

it("places document review before preparation when a paid order needs review", () => {
  render(
    <PaymentJourneyConfirmation
      orderNumber="VC-REVIEW"
      amountNpr={652}
      status="REVIEW_PENDING"
      trackingHref="/partner-checkout/private"
      trackingLabel="Track this order"
    />,
  );
  expect(screen.getByText("Reviewing documents")).toBeDefined();
  expect(
    screen.getByText("Preparation starts after document review."),
  ).toBeDefined();
  expect(screen.getByText(/No further payment is needed/i)).toBeDefined();
});

it("marks installation ready only after the order reaches QR_READY", () => {
  render(
    <PaymentJourneyConfirmation
      orderNumber="VC-READY"
      amountNpr={652}
      status="QR_READY"
      trackingHref="/account/orders/ready"
      trackingLabel="View order"
    />,
  );
  expect(screen.getByText("Your eSIM is ready")).toBeDefined();
  expect(
    screen.getByText("Your installation details are ready."),
  ).toBeDefined();
});

it("uses recharge milestones without offering a new QR or installation", () => {
  const props = {
    mode: "recharge" as const,
    orderNumber: "VC-TOPUP",
    amountNpr: 450,
    trackingHref: "/account/esims",
    trackingLabel: "View my eSIM",
  };
  const view = render(
    <PaymentJourneyConfirmation {...props} status="PROVISIONING" />,
  );
  expect(screen.getByText("We’re adding data to your eSIM")).toBeDefined();
  expect(screen.queryByText("Ready to install")).toBeNull();
  view.rerender(<PaymentJourneyConfirmation {...props} status="QR_READY" />);
  expect(screen.getByText("Data has been added to your eSIM")).toBeDefined();
  expect(
    screen.getByText(/No new QR code or installation is needed/i),
  ).toBeDefined();
  view.rerender(<PaymentJourneyConfirmation {...props} status="COMPLETED" />);
  expect(
    screen.getAllByText("Your new data package is active").length,
  ).toBeGreaterThan(0);
});
