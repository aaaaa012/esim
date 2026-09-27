import { describe, expect, it } from "vitest";
import {
  AttentionAction,
  attentionActionLabel,
  isAttentionAction,
} from "./attention-actions.js";

describe("attention action contract", () => {
  it("accepts every executable action and gives it an operator label", () => {
    for (const action of Object.values(AttentionAction)) {
      expect(isAttentionAction(action)).toBe(true);
      expect(attentionActionLabel(action)).not.toMatch(/_/);
    }
  });

  it("rejects old diagnostic suggestions with no executable handler", () => {
    expect(isAttentionAction("CHECK_REDIS")).toBe(false);
    expect(isAttentionAction("CHECK_NETWORK")).toBe(false);
    expect(isAttentionAction("CHECK_CREDENTIALS")).toBe(false);
  });
});
