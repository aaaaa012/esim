const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodeAes256Key(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length)
    throw new Error("APP_ENCRYPTION_KEY_BASE64 is required");
  if (!BASE64_PATTERN.test(value) || value.length % 4 !== 0)
    throw new Error("APP_ENCRYPTION_KEY_BASE64 must be strict Base64");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new Error(
      "APP_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes",
    );
  return key;
}
