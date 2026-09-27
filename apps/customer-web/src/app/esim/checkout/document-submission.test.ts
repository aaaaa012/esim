import { describe, expect, it } from "vitest";
import { DocumentType } from "@visa-compass/shared";
import { submitCheckoutDocumentsSequentially } from "./document-submission";

describe("submitCheckoutDocumentsSequentially", () => {
  it("waits for each document workflow before starting the next one", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const files = {
      passport: new File(["passport"], "passport.pdf"),
      ticket: new File(["ticket"], "ticket.pdf"),
      visa: new File(["visa"], "visa.pdf"),
    };

    await submitCheckoutDocumentsSequentially(files, async (document) => {
      started.push(document.key);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      completed.push(document.key);
      active -= 1;
    });

    expect(started).toEqual(["passport", "ticket", "visa"]);
    expect(completed).toEqual(["passport", "ticket", "visa"]);
    expect(maximumActive).toBe(1);
  });

  it("maps each file to the corresponding API document type", async () => {
    const types: DocumentType[] = [];

    await submitCheckoutDocumentsSequentially(
      {
        passport: new File(["passport"], "passport.pdf"),
        ticket: new File(["ticket"], "ticket.pdf"),
        visa: new File(["visa"], "visa.pdf"),
      },
      async (document) => {
        types.push(document.type);
      },
    );

    expect(types).toEqual([
      DocumentType.PASSPORT,
      DocumentType.TICKET,
      DocumentType.VISA,
    ]);
  });

  it("stops before submission when a document exceeds 10 MB", async () => {
    const submitted: string[] = [];
    const oversized = new File(
      [new Uint8Array(10 * 1024 * 1024 + 1)],
      "ticket.pdf",
    );

    await expect(
      submitCheckoutDocumentsSequentially(
        {
          passport: new File(["passport"], "passport.pdf"),
          ticket: oversized,
          visa: undefined,
        },
        async (document) => {
          submitted.push(document.key);
        },
      ),
    ).rejects.toThrow("ticket.pdf exceeds the 10 MB limit");
    expect(submitted).toEqual([]);
  });
});
