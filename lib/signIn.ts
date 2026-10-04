// Sign In With Solana against Kinlog's server (functions/src/auth). authNonce hands out a sign-in
// payload, the wallet signs the SIWS text built from it, and authVerify checks that signature and
// returns a Firebase custom token whose uid is the wallet address.
import type { SignInPayload, SignInResult } from '@solana-mobile/mobile-wallet-adapter-protocol';
import { PublicKey } from '@solana/web3.js';

const FUNCTIONS_URL = 'https://asia-northeast3-kinlog-6549a.cloudfunctions.net';
const NONCE_TIMEOUT_MS = 8_000;
// authVerify can take a few seconds on a cold start.
const VERIFY_TIMEOUT_MS = 20_000;

export class SignInError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SignInError';
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The sign-in payload to pass to MWA `authorize`, or null when the server can't be reached. */
export async function fetchSignInPayload(): Promise<SignInPayload | null> {
  try {
    const res = await fetchWithTimeout(`${FUNCTIONS_URL}/authNonce`, { method: 'GET' }, NONCE_TIMEOUT_MS);
    if (!res.ok) {
      console.log('authNonce failed:', res.status);
      return null;
    }
    const p = await res.json();
    // The MWA fallback (sign_messages) needs `domain`; React Native has no window.location.
    if (typeof p?.domain !== 'string' || typeof p?.nonce !== 'string') return null;
    return p as SignInPayload;
  } catch (e: any) {
    console.log('authNonce unreachable:', e?.message ?? e);
    return null;
  }
}

/** Base58 wallet address of a sign-in result (MWA returns it base64-encoded). */
export function signInAddress(result: SignInResult): string {
  return new PublicKey(Buffer.from(result.address, 'base64')).toBase58();
}

/** Exchanges a wallet's sign-in signature for a Firebase custom token. Throws SignInError. */
export async function verifySignIn(result: SignInResult): Promise<string> {
  const body = {
    address: signInAddress(result),
    message: result.signed_message,
    signature: result.signature,
  };
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${FUNCTIONS_URL}/authVerify`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      VERIFY_TIMEOUT_MS,
    );
  } catch {
    throw new SignInError('network');
  }
  const out = await res.json().catch(() => ({}));
  if (res.ok && typeof out?.token === 'string') return out.token;
  throw new SignInError(typeof out?.error === 'string' ? out.error : `http_${res.status}`);
}

export function signInErrorMessage(e: unknown): string {
  const code = e instanceof SignInError ? e.code : '';
  switch (code) {
    case 'unavailable':
    case 'network':
      return "Couldn't reach the sign-in server. Try again.";
    case 'nonce_expired':
    case 'nonce_used':
      return 'The sign-in request expired. Try again.';
    case 'invalid_message':
    case 'invalid_signature':
    case 'invalid_nonce':
    case 'invalid_request':
      return 'The sign-in signature was not accepted. Try again.';
    case 'no_signature':
      return "The wallet didn't return a sign-in signature. Try again.";
    case 'account_mismatch':
      return 'The wallet signed in with a different account. Try again.';
    default:
      return "Couldn't sign in. Try again.";
  }
}
