import { describe, expect, it } from "vitest";
import { renderNotification } from "./notification.templates.js";
describe("notification templates", () => {
  it("does not expose QR credentials in the ready message", () => {
    const value = renderNotification("QR_READY", {
      orderNumber: "VC-2026-TEST",
    });
    expect(value.text.toLowerCase()).toContain("attached as an image");
    expect(value.text.toLowerCase()).not.toContain("pdf");
    expect(value.text).not.toContain("LPA:");
    expect(value.html).toContain("Visa Compass");
    expect(value.html).toContain("View your eSIM");
  });
  it("includes the operator reason in a re-upload request", () => {
    expect(
      renderNotification("DOCUMENT_REUPLOAD", {
        orderNumber: "VC-1",
        reason: "Image is blurred",
      }).text,
    ).toContain("Image is blurred");
  });

  it("escapes operator-provided content in HTML", () => {
    const value = renderNotification("DOCUMENT_REUPLOAD", {
      orderNumber: "VC-1",
      reason: '<script>alert("x")</script>',
    });
    expect(value.html).not.toContain("<script>");
    expect(value.html).toContain("&lt;script&gt;");
  });
});
