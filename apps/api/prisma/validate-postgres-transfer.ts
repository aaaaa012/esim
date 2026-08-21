import { clients, fingerprint, migrationModels } from "./transfer-helpers.js";

async function main() {
  const { source, target } = clients();
  let failed = false;
  try {
    for (const model of migrationModels()) {
      const [sourceState, targetState] = await Promise.all([
        fingerprint(source, model),
        fingerprint(target, model),
      ]);
      const matches =
        sourceState.count === targetState.count &&
        sourceState.sha256 === targetState.sha256;
      process.stdout.write(
        `${matches ? "OK" : "MISMATCH"} ${model.name}: ${sourceState.count}/${targetState.count}\n`,
      );
      failed ||= !matches;
    }
  } finally {
    await Promise.allSettled([source.$disconnect(), target.$disconnect()]);
  }
  if (failed) throw new Error("Source and target fingerprints differ");
  process.stdout.write(
    "All application model counts and fingerprints match.\n",
  );
}

main().catch((error) => {
  process.stderr.write(
    `Transfer validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
