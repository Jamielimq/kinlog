import crypto from "node:crypto";
import type { Keypair } from "@solana/web3.js";

// PKCS#8 prefix for a raw 32-byte Ed25519 seed (the first half of a Solana secret key).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function signBytes(kp: Keypair, message: Uint8Array): Buffer {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(kp.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(message), key);
}
