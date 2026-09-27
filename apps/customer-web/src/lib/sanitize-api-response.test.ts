import { describe, expect, it } from "vitest";
import { sanitizeApiResponse } from "./sanitize-api-response";

describe("sanitizeApiResponse", () => {
  it("removes provider messages and correlation metadata from rendered error copy", async () => {
    const response = new Response(JSON.stringify({ error: { code: "CLERK_ACTIVATION_FAILED", message: "form_data_missing correlationId=secret" }, meta: { correlationId: "secret" } }), { status: 400, headers: { "content-type": "application/json" } });
    const body = await (await sanitizeApiResponse(response)).json();
    expect(body.error.message).toBe("Something went wrong. Please try again.");
    expect(body.error.message).not.toContain("secret");
  });
});
