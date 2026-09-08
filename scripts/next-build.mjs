import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const appDir = process.cwd();
const root = path.join(appDir, "..", "..");
const nextEnvPath = path.join(appDir, "next-env.d.ts");
const nextEnvExisted = existsSync(nextEnvPath);
const nextEnvContents = nextEnvExisted ? readFileSync(nextEnvPath) : null;
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

function restoreNextEnv() {
  if (nextEnvContents) {
    const currentContents = existsSync(nextEnvPath)
      ? readFileSync(nextEnvPath)
      : null;

    if (!currentContents?.equals(nextEnvContents)) {
      writeFileSync(nextEnvPath, nextEnvContents);
    }
    return;
  }

  if (!nextEnvExisted) rmSync(nextEnvPath, { force: true });
}

child.on("error", (error) => {
  restoreNextEnv();
  console.error(error);
  process.exit(1);
});

child.on("close", (code, signal) => {
  restoreNextEnv();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
