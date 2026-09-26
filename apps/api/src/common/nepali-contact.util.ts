/** Canonical contact number for new Nepal checkout orders. */
export function normalizeNepaliContact(input: string): string | null {
  const compact = input.trim().replace(/[\s()-]/g, "");
  const local = /^9\d{9}$/.test(compact)
    ? compact
    : compact.startsWith("+977")
    ? compact.slice(4)
    : compact.startsWith("00977")
      ? compact.slice(5)
      : compact.startsWith("977")
        ? compact.slice(3)
        : compact;
  return /^9\d{9}$/.test(local) ? `977${local}` : null;
}
