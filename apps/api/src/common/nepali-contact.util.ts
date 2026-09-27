/** Canonical contact key for checkout and recharge lookup (legacy +977 accepted). */
export function normalizeNepaliContact(input: string): string | null {
  const compact = input.trim().replace(/[\s()-]/g, "");
  const local = /^\d{10}$/.test(compact)
    ? compact
    : compact.startsWith("+977")
    ? compact.slice(4)
    : compact.startsWith("00977")
      ? compact.slice(5)
      : compact.startsWith("977")
        ? compact.slice(3)
        : compact;
  return /^\d{10}$/.test(local) ? `977${local}` : null;
}
