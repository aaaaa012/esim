import { describe, expect, it } from "vitest";
import {
  DocumentReviewStatus,
  DocumentStatus,
  OrderStatus,
} from "./contracts.js";
import {
  documentReviewPresentation,
  documentStatusPresentation,
  orderStatusPresentation,
} from "./status-presentation.js";

describe("exhaustive status presentation", () => {
  it("maps every current order status", () => {
    for (const status of Object.values(OrderStatus))
      expect(orderStatusPresentation(status).label).not.toBe(
        "Status unavailable",
      );
  });

  it("maps every current document and review status", () => {
    for (const status of Object.values(DocumentStatus))
      expect(documentStatusPresentation(status).label).not.toBe(
        "Status unavailable",
      );
    for (const status of Object.values(DocumentReviewStatus))
      expect(documentReviewPresentation(status).label).not.toBe(
        "Status unavailable",
      );
  });

  it("offers no customer action for unknown future statuses", () => {
    expect(orderStatusPresentation("FUTURE_STATE")).toMatchObject({
      label: "Status unavailable",
      customerAction: "NONE",
    });
  });
});
