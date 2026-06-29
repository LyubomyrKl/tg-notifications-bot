import {
  generateApiKey,
  generateToken,
  hashApiKey,
  hashPassword,
  verifyPassword,
} from './crypto.util';

describe('crypto.util', () => {
  it('hashes API keys deterministically and never stores the raw key', () => {
    const { key, hash } = generateApiKey();
    expect(key).toMatch(/^pk_/);
    expect(hash).toHaveLength(64); // sha256 hex
    expect(hash).not.toContain(key);
    expect(hashApiKey(key)).toBe(hash); // lookups recompute the same hash
  });

  it('generates unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(tokens.size).toBe(500);
  });

  it('verifies passwords via bcrypt', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('correct-horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
