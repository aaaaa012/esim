import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BATCH_SIZE,
  clients,
  delegate,
  fingerprint,
  optionalForeignKeys,
  requiredDependencyOrder,
  stableOrder,
  uniqueWhere,
} from "./transfer-helpers.js";

const checkpointPath =
  process.env.DB_TRANSFER_CHECKPOINT ??
  join(process.cwd(), ".postgres-transfer-checkpoint.json");

async function loadCheckpoint(): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      completed: string[];
    };
    return new Set(parsed.completed);
  } catch {
    return new Set();
  }
}

async function saveCheckpoint(completed: Set<string>) {
  await writeFile(
    checkpointPath,
    `${JSON.stringify({ completed: [...completed].sort() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function main() {
  const { source, target } = clients();
  const completed = await loadCheckpoint();
  try {
    if (completed.size === 0) {
      const populated: string[] = [];
      for (const model of requiredDependencyOrder()) {
        const count = await delegate(target, model.name).count();
        if (count > 0) populated.push(`${model.name} (${count})`);
      }
      if (populated.length) {
        throw new Error(
          `Target contains application data; refusing to write: ${populated.join(", ")}`,
        );
      }
    }

    for (const model of requiredDependencyOrder()) {
      const sourceState = await fingerprint(source, model);
      const targetState = await fingerprint(target, model);
      if (completed.has(model.name)) {
        if (sourceState.count !== targetState.count) {
          throw new Error(
            `Checkpoint mismatch for ${model.name}; reset the target schema`,
          );
        }
        process.stdout.write(
          `${model.name}: already copied (${sourceState.count})\n`,
        );
        continue;
      }
      if (targetState.count !== 0) {
        throw new Error(
          `${model.name} already contains target rows; refusing to overwrite`,
        );
      }

      const optionalKeys = optionalForeignKeys(model);
      let offset = 0;
      while (true) {
        const rows = (await delegate(source, model.name).findMany({
          orderBy: stableOrder(model),
          skip: offset,
          take: BATCH_SIZE,
        })) as Record<string, unknown>[];
        if (!rows.length) break;
        const initialRows = rows.map((row) => {
          const copy = { ...row };
          for (const field of optionalKeys) copy[field] = null;
          return copy;
        });
        await delegate(target, model.name).createMany({ data: initialRows });
        offset += rows.length;
      }
      completed.add(model.name);
      await saveCheckpoint(completed);
      process.stdout.write(`${model.name}: copied ${sourceState.count}\n`);
    }

    for (const model of requiredDependencyOrder()) {
      const optionalKeys = optionalForeignKeys(model);
      if (!optionalKeys.length) continue;
      let offset = 0;
      while (true) {
        const rows = (await delegate(source, model.name).findMany({
          orderBy: stableOrder(model),
          skip: offset,
          take: BATCH_SIZE,
        })) as Record<string, unknown>[];
        if (!rows.length) break;
        for (const row of rows) {
          const data = Object.fromEntries(
            optionalKeys
              .filter((field) => row[field] !== null)
              .map((field) => [field, row[field]]),
          );
          if (
            Object.keys(data).length &&
            model.fields.some((field) => field.name === "updatedAt") &&
            row.updatedAt
          ) {
            data.updatedAt = row.updatedAt;
          }
          if (Object.keys(data).length) {
            await delegate(target, model.name).update({
              where: uniqueWhere(model, row),
              data,
            });
          }
        }
        offset += rows.length;
      }
    }
    process.stdout.write(
      "Transfer completed. Run db:validate-transfer before cutover.\n",
    );
  } finally {
    await Promise.allSettled([source.$disconnect(), target.$disconnect()]);
  }
}

main().catch((error) => {
  process.stderr.write(
    `Database transfer failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
