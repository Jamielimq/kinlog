// Sign In With Solana message text (the wallet-standard format that MWA wallets build from a
// sign-in payload) and ed25519 verification with node:crypto.
import crypto from "node:crypto";

export interface SignInFields {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

const HEADER = " wants you to sign in with your Solana account:";
const FIELDS: [keyof SignInFields, string][] = [
  ["uri", "URI"],
  ["version", "Version"],
  ["chainId", "Chain ID"],
  ["nonce", "Nonce"],
  ["issuedAt", "Issued At"],
  ["expirationTime", "Expiration Time"],
  ["notBefore", "Not Before"],
  ["requestId", "Request ID"],
];

/** Same text as wallet-standard's createSignInMessageText; the signMessages fallback signs this. */
export function buildSignInMessage(f: SignInFields): string {
  let message = `${f.domain}${HEADER}\n${f.address}`;
  if (f.statement) message += `\n\n${f.statement}`;
  const lines: string[] = [];
  for (const [key, label] of FIELDS) if (f[key]) lines.push(`${label}: ${f[key]}`);
  if (f.resources?.length) lines.push("Resources:", ...f.resources.map((r) => `- ${r}`));
  if (lines.length) message += `\n\n${lines.join("\n")}`;
  return message;
}

export function parseSignInMessage(text: string): SignInFields | null {
  const lines = text.split("\n");
  if (lines.length < 2 || !lines[0].endsWith(HEADER)) return null;
  const out: SignInFields = { domain: lines[0].slice(0, -HEADER.length), address: lines[1] };
  const rest = lines.slice(2);
  if (!rest.length) return out;
  if (rest[0] !== "") return null;
  let i = 1;
  const isField = (l: string) => l === "Resources:" || FIELDS.some(([, label]) => l.startsWith(`${label}: `));
  if (i < rest.length && !isField(rest[i])) {
    out.statement = rest[i++];
    if (i < rest.length) {
      if (rest[i] !== "") return null;
      i++;
    }
  }
  const seen = new Set<string>();
  for (; i < rest.length; i++) {
    const line = rest[i];
    if (line === "Resources:") {
      out.resources = [];
      while (i + 1 < rest.length && rest[i + 1].startsWith("- ")) out.resources.push(rest[++i].slice(2));
      continue;
    }
    const field = FIELDS.find(([, label]) => line.startsWith(`${label}: `));
    if (!field || seen.has(field[1])) return null;
    seen.add(field[1]);
    (out as unknown as Record<string, string>)[field[0]] = line.slice(field[1].length + 2);
  }
  return out;
}

// DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}
