import { createHash } from "node:crypto";
import {
  Prisma as TargetPrisma,
  PrismaClient as TargetClient,
} from "@prisma/client";
import {
  Prisma as SourcePrisma,
  PrismaClient as SourceClient,
} from "../generated/cockroach-client/index.js";

export const BATCH_SIZE = 250;
const RETRYABLE_READ_CODES = new Set(["P1001", "P1008", "P1017", "P2024"]);

type DynamicClient = Record<string, any>;

export function delegate(client: object, model: string): any {
  const name = model.charAt(0).toLowerCase() + model.slice(1);
  const value = (client as DynamicClient)[name];
  if (!value) throw new Error(`Missing Prisma delegate for ${model}`);
  return value;
}

async function withReadRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      const message = error instanceof Error ? error.message : "";
      const retryable =
        RETRYABLE_READ_CODES.has(code) ||
        message.includes("Server has closed the connection");
      if (!retryable || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error("Unreachable read retry state");
}

export function migrationModels() {
  return TargetPrisma.dmmf.datamodel.models;
}

export function requiredDependencyOrder(): typeof TargetPrisma.dmmf.datamodel.models {
  const models = migrationModels();
  const names = new Set(models.map((model) => model.name));
  const dependencies = new Map<string, Set<string>>();
  for (const model of models) {
    const required = new Set<string>();
    for (const field of model.fields) {
      if (
        field.kind === "object" &&
        field.isRequired &&
        field.relationFromFields?.length &&
        names.has(field.type)
      ) {
        required.add(field.type);
      }
    }
    dependencies.set(model.name, required);
  }

  const ordered: Array<(typeof models)[number]> = [];
  const remaining = new Map(models.map((model) => [model.name, model]));
  while (remaining.size) {
    const ready = [...remaining.values()].filter((model) =>
      [...(dependencies.get(model.name) ?? [])].every(
        (dependency) => !remaining.has(dependency),
      ),
    );
    if (!ready.length) {
      throw new Error(
        `Required foreign-key cycle detected: ${[...remaining.keys()].join(", ")}`,
      );
    }
    ready.sort((left, right) => left.name.localeCompare(right.name));
    for (const model of ready) {
      ordered.push(model);
      remaining.delete(model.name);
    }
  }
  return ordered;
}

export function optionalForeignKeys(
  model: ReturnType<typeof migrationModels>[number],
) {
  return model.fields
    .filter(
      (field) =>
        field.kind === "object" &&
        !field.isRequired &&
        Boolean(field.relationFromFields?.length),
    )
    .flatMap((field) => field.relationFromFields ?? []);
}

export function stableOrder(model: ReturnType<typeof migrationModels>[number]) {
  const id = model.fields.find((field) => field.isId);
  if (id) return { [id.name]: "asc" };
  const primary = model.primaryKey?.fields?.[0];
  if (primary) return { [primary]: "asc" };
  const scalar = model.fields.find((field) => field.kind === "scalar");
  if (!scalar) throw new Error(`No scalar ordering field for ${model.name}`);
  return { [scalar.name]: "asc" };
}

export function uniqueWhere(
  model: ReturnType<typeof migrationModels>[number],
  row: Record<string, unknown>,
) {
  const id = model.fields.find((field) => field.isId);
  if (id) return { [id.name]: row[id.name] };
  const primary = model.primaryKey?.fields;
  if (!primary?.length) throw new Error(`No primary key for ${model.name}`);
  return {
    [model.primaryKey?.name ?? primary.join("_")]: Object.fromEntries(
      primary.map((field) => [field, row[field]]),
    ),
  };
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (
    SourcePrisma.Decimal.isDecimal(value) ||
    TargetPrisma.Decimal.isDecimal(value)
  ) {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export async function fingerprint(
  client: object,
  model: ReturnType<typeof migrationModels>[number],
) {
  const hash = createHash("sha256");
  let offset = 0;
  let count = 0;
  while (true) {
    const rows = (await withReadRetry(() =>
      delegate(client, model.name).findMany({
        orderBy: stableOrder(model),
        skip: offset,
        take: BATCH_SIZE,
      }),
    )) as Record<string, unknown>[];
    if (!rows.length) break;
    for (const row of rows) hash.update(`${JSON.stringify(canonical(row))}\n`);
    count += rows.length;
    offset += rows.length;
  }
  return { count, sha256: hash.digest("hex") };
}

export function clients() {
  if (!process.env.SOURCE_DATABASE_URL)
    throw new Error("SOURCE_DATABASE_URL is required");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return { source: new SourceClient(), target: new TargetClient() };
}
