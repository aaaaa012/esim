export type ProcessRole = "api" | "workflow-worker" | "ocr-worker";

export function requireProcessRole(expected: ProcessRole) {
  const configured = process.env.PROCESS_ROLE;
  if (process.env.NODE_ENV === "production" && configured !== expected)
    throw new Error(
      `PROCESS_ROLE must be '${expected}' for this production entrypoint (received ${configured || "unset"}).`,
    );
  if (configured && configured !== expected)
    throw new Error(
      `This entrypoint requires PROCESS_ROLE='${expected}' (received '${configured}').`,
    );
}
