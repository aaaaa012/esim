import { spawn } from "node:child_process";
import path from "node:path";

const appDir = process.cwd();
const root = path.join(appDir, "..", "..");
const nextBin = path.join(
  appDir,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);

const child = spawn(
  process.execPath,
  ["--env-file-if-exists", path.join(root, ".env"), nextBin, "build"],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
);

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});