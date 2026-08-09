const MAX_OFFSET = 100_000;

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export function paginate<T>(items: T[], limitRaw?: string, offsetRaw?: string): Page<T> {
  const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);
  const offset = Math.min(Math.max(Number(offsetRaw) || 0, 0), MAX_OFFSET);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    page: Math.floor(offset / limit) + 1,
    pageSize: limit,
  };
}

/** Case-insensitive substring match across any number of candidate fields. */
export function matchesQuery(query: string, ...values: (string | null | undefined)[]) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((value) => value?.toLowerCase().includes(q) ?? false);
}