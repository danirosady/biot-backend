import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";

// Ensure env is loaded even if the importer hasn't called dotenv yet
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const keyB64Raw = process.env.ENCRYPTION_KEY ?? "";
const keyB64 = keyB64Raw.trim();
if (!keyB64) {
  throw new Error("ENCRYPTION_KEY is required (32-byte base64).");
}
const key = Buffer.from(keyB64, "base64");
if (key.length !== 32) {
  throw new Error("ENCRYPTION_KEY must be 32 bytes (base64-encoded).");
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(ciphertextB64: string): string {
  const buf = Buffer.from(ciphertextB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}