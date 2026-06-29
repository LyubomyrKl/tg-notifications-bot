import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';

const BCRYPT_ROUNDS = 12;

/** Hash a user password for storage. */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, BCRYPT_ROUNDS);
}

/** Verify a candidate password against a stored bcrypt hash. */
export function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return compare(plain, hashed);
}

/**
 * Generate a public API key + its storage hash. The raw key is shown to the
 * Source exactly once at provisioning; only the SHA-256 hash is persisted, so a
 * DB leak never exposes usable keys. Lookups hash the incoming key and match.
 */
export function generateApiKey(): { key: string; hash: string } {
  const key = `pk_${randomBytes(24).toString('hex')}`;
  return { key, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * High-entropy, URL-safe opaque token for deep-links (start tokens, later
 * invite tokens). Random + DB lookup — revocation is a DB state change.
 */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
