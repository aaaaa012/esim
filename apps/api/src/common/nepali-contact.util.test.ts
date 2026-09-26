import { describe, expect, it } from "vitest";
import { normalizeNepaliContact } from "./nepali-contact.util.js";

describe("normalizeNepaliContact", () => {
  it.each([
    "9800000000",
    "9779800000000",
    "+977 9800000000",
    "00977-9800000000",
  ])("normalizes %s", (input) => {
    expect(normalizeNepaliContact(input)).toBe("9779800000000");
  });

  it("accepts any 10 digits without a prefix rule", () => {
    expect(normalizeNepaliContact("1234567890")).toBe("9771234567890");
  });

  it.each(["", "+33123456789", "980000000", "abc9800000000"])(
    "rejects %s",
    (input) => {
      expect(normalizeNepaliContact(input)).toBeNull();
    },
  );
});
