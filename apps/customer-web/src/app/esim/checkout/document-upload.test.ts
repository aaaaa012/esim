import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentUploader } from "./document-upload";
import { hasSavedDocument } from "./document-progress";

afterEach(() => vi.unstubAllGlobals());

describe("document upload recovery", () => {
  it("retries confirmation without uploading or authorizing the same file again", async () => {
    const put = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", put);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        id: "doc",
        upload: {
          mode: "s3-presigned",
          endpoint: "https://storage.example/upload",
        },
      })
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce({});
    const upload = createDocumentUploader();
    const options = {
      type: "PASSPORT",
      file: new File(["passport"], "passport.png"),
      basePath: "/orders/one/documents",
      request,
      progress: vi.fn(),
    };
    await expect(upload(options)).rejects.toThrow("Disconnected");
    await expect(upload(options)).resolves.toMatchObject({
      uploadVerified: true,
      fileName: "passport.png",
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/orders/one/documents",
      "/orders/one/documents/doc/confirm",
      "/orders/one/documents/doc/confirm",
    ]);
  });

  it("gets a fresh authorization when a storage upload fails", async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", put);
    const request = vi
      .fn()
      .mockResolvedValue({
        id: "doc",
        upload: {
          mode: "s3-presigned",
          endpoint: "https://storage.example/upload",
        },
      });
    const upload = createDocumentUploader();
    const options = {
      type: "TICKET",
      file: new File(["ticket"], "ticket.png"),
      basePath: "/documents",
      request,
      progress: vi.fn(),
    };
    await expect(upload(options)).rejects.toThrow(
      "your other saved files are safe",
    );
    await upload(options);
    expect(
      request.mock.calls.filter(([path]) => path === "/documents"),
    ).toHaveLength(2);
  });

  it("does not treat unconfirmed or rejected files as saved", () => {
    expect(
      hasSavedDocument([{ type: "PASSPORT", status: "UPLOADED" }], "PASSPORT"),
    ).toBe(false);
    expect(
      hasSavedDocument(
        [
          {
            type: "PASSPORT",
            status: "REUPLOAD_REQUIRED",
            uploadVerified: true,
          },
        ],
        "PASSPORT",
      ),
    ).toBe(false);
    expect(
      hasSavedDocument(
        [{ type: "PASSPORT", status: "UPLOADED", uploadVerified: true }],
        "PASSPORT",
      ),
    ).toBe(true);
  });
});
