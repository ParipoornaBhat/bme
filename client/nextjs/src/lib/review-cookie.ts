/**
 * Edge-safe review session cookie utilities using Web Crypto API.
 * Cookie format: <username>.<expiresMs>.<hmacHex>
 */

export async function verifyReviewCookie(
  value: string | undefined | null,
): Promise<{ username: string } | null> {
  if (!value) return null;
  const secret = process.env.REVIEW_SESSION_SECRET;
  if (!secret) return null;

  const parts = value.split(".");
  if (parts.length !== 3) return null;

  const [username, expiresStr, signatureHex] = parts;
  const expiresMs = Number(expiresStr);
  if (!username || !Number.isFinite(expiresMs) || expiresMs < Date.now()) {
    return null;
  }

  if (signatureHex.length !== 64) return null;

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const sigBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      sigBytes[i] = parseInt(signatureHex.substring(i * 2, i * 2 + 2), 16);
    }

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      enc.encode(`${username}.${expiresStr}`),
    );

    if (!isValid) return null;
    return { username };
  } catch {
    return null;
  }
}

/**
 * Signs a review session cookie using HMAC-SHA256 with Web Crypto.
 */
export async function signReviewCookie(
  username: string,
  expiresMs: number,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const data = enc.encode(`${username}.${expiresMs}`);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${username}.${expiresMs}.${sigHex}`;
}
