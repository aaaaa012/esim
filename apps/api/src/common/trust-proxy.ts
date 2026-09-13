/** Accept only explicit proxy hops or address ranges; blanket trust permits IP spoofing. */
export function trustProxySetting(): false | string | number {
  const value = process.env.TRUST_PROXY?.trim();
  if (!value || value === "" || value === "false") return false;
  if (value === "true")
    throw new Error(
      "TRUST_PROXY=true is unsafe. Configure the exact proxy hop count or trusted proxy CIDR list.",
    );
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops >= 1 && hops <= 10) return hops;
    throw new Error("TRUST_PROXY hop count must be between 1 and 10.");
  }
  const entries = value.split(",").map((entry) => entry.trim());
  const allowedName = /^(loopback|linklocal|uniquelocal)$/i;
  const addressOrCidr = /^[0-9a-f:.]+(?:\/\d{1,3})?$/i;
  if (
    entries.some(
      (entry) =>
        !entry || (!allowedName.test(entry) && !addressOrCidr.test(entry)),
    )
  )
    throw new Error(
      "TRUST_PROXY must contain only explicit IP/CIDR values or loopback, linklocal, and uniquelocal.",
    );
  return entries.join(", ");
}
