// Tokens another service gave someone (a GitHub token for a private repository), kept sealed with SECRET_KEY using
// AES-256-GCM, so a copy of the database alone doesn't hold them. Without SECRET_KEY nothing is kept.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const key = () => (process.env.SECRET_KEY ? createHash("sha256").update(process.env.SECRET_KEY).digest() : null);

export const canSeal = () => key() !== null;

export function seal(text: string): string {
  const k = key();
  if (!k) throw new Error("SECRET_KEY isn't set");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function unseal(sealed: string): string | null {
  const k = key();
  if (!k) return null;
  try {
    const data = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", k, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
