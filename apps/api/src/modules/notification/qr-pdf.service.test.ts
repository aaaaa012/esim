import { describe, expect, it } from "vitest";
import { QrPdfService } from "./qr-pdf.service.js";

describe("QrPdfService", () => {
  it("builds an unencrypted QR PDF that does not require a password", async () => {
    const pdf = await new QrPdfService().build({
      qrPayload: "LPA:1$consumer.example$activation-code",
      orderNumber: "VC-1000",
    });

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).not.toContain("/Encrypt");
  });
});
