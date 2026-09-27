import { Keypair } from "@solana/web3.js";

/**
 * Keypair from a Secret Manager value (the JSON array written by solana-keygen). Error messages never
 * include any part of the value.
 */
export function keypairFromSecret(value: string | undefined, name: string): Keypair {
  if (!value || !value.trim()) throw new Error(`${name} is not set`);
  let bytes: unknown;
  try {
    bytes = JSON.parse(value.trim());
  } catch {
    throw new Error(`${name} is not a JSON keypair array`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error(`${name} must be a 64-byte keypair array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}
