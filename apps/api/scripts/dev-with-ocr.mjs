import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const node = process.execPath;
const environmentFile = "--env-file-if-exists=../../.env";

const processes = [];
const workerOutput = "dist/src/ocr-worker.js";
const apiStartedAt = Date.now();

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(waitForWorkerBuild);
  for (const child of processes) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

function watch(child) {
  processes.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(
      `Development child exited${signal ? ` from ${signal}` : ` with code ${code ?? 1}`}; stopping the API development stack.`,
    );
    stop(code ?? 1);
  });
  child.on("error", (error) => {
    console.error("Could not start the API development stack:", error);
    stop(1);
  });
}

watch(
  spawn(
    node,
    [
      environmentFile,
      "node_modules/@nestjs/cli/bin/nest.js",
      "start",
      "--watch",
    ],
    { stdio: "inherit" },
  ),
);

const waitForWorkerBuild = setInterval(() => {
  if (stopping || !existsSync(workerOutput)) return;
  if (statSync(workerOutput).mtimeMs < apiStartedAt - 1_000) return;
  clearInterval(waitForWorkerBuild);
  watch(
    spawn(node, [environmentFile, "--watch", workerOutput], {
      stdio: "inherit",
    }),
  );
}, 100);

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
