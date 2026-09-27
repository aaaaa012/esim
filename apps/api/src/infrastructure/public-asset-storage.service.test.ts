import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { PublicAssetStorageService } from "./public-asset-storage.service.js";

describe("PublicAssetStorageService artwork validation", () => {
  const subject = new PublicAssetStorageService() as unknown as {
    displayFormat(width: number, height: number): string;
    inspectImage(bytes: Buffer): {
      kind: string;
      width: number;
      height: number;
    };
    requireCampaignKey(key: string): void;
  };

  it("classifies approved portrait, square, and landscape ratios", () => {
    expect(subject.displayFormat(768, 1376)).toBe("PORTRAIT");
    expect(subject.displayFormat(1200, 1200)).toBe("SQUARE");
    expect(subject.displayFormat(1600, 477)).toBe("LANDSCAPE");
  });

  it("reads PNG signatures and dimensions", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
    png.writeUInt32BE(1600, 16);
    png.writeUInt32BE(477, 20);
    expect(subject.inspectImage(png)).toEqual({
      kind: "png",
      width: 1600,
      height: 477,
    });
  });

  it("isolates public marketing objects to the campaign prefix", () => {
    expect(() =>
      subject.requireCampaignKey(
        "visa-compass/marketing/campaigns/campaign_0123456789ab_123e4567-e89b-12d3-a456-426614174000.jpg",
      ),
    ).not.toThrow();
    expect(() =>
      subject.requireCampaignKey("visa-compass/private/passport.jpg"),
    ).toThrow(BadRequestException);
    expect(() =>
      subject.requireCampaignKey(
        "visa-compass/marketing/campaigns/../secret.jpg",
      ),
    ).toThrow(BadRequestException);
  });
});
