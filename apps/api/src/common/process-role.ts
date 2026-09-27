export type ProcessRole = "api" | "workflow-worker" | "ocr-worker";

export function requireProcessRole(expected: ProcessRole) {
  const configured = process.env.PROCESS_ROLE;
  if (!configured) return;
  if (configured !== expected)
    throw new Error(
      `This entrypoint requires PROCESS_ROLE='${expected}' (received '${configured}').`,
    );
}
