import { describe, it, expect } from 'vitest';
import {
  randomBytes,
  randomId,
  encode,
  decode,
  toBase64,
  fromBase64,
  concat,
  equal,
  aesGcmEncrypt,
  aesGcmDecrypt,
  hkdf,
  hmacSha256,
  sha256,
  sha512,
  pbkdf2,
  generateX25519KeyPair,
  x25519DH,
  generateEd25519KeyPair,
  ed25519Sign,
  ed25519Verify,
  generateSafetyNumber,
} from './crypto-utils.js';

describe('randomBytes', () => {
  it('returns the requested number of bytes', () => {
    expect(randomBytes(32).length).toBe(32);
    expect(randomBytes(16).length).toBe(16);
    expect(randomBytes(0).length).toBe(0);
  });

  it('returns different values each call', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(equal(a, b)).toBe(false);
  });
});

describe('randomId', () => {
  it('returns a 32-char hex string', () => {
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('encode / decode', () => {
  it('round-trips a UTF-8 string', () => {
    const msg = 'Hello RocChat 🔒';
    expect(decode(encode(msg))).toBe(msg);
  });
});

describe('toBase64 / fromBase64', () => {
  it('round-trips binary data', () => {
    const data = randomBytes(48);
    const b64 = toBase64(data);
    const back = fromBase64(b64);
    expect(equal(data, back)).toBe(true);
  });

  it('returns valid base64', () => {
    const b64 = toBase64(new Uint8Array([0, 1, 255]));
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('concat', () => {
  it('concatenates multiple arrays', () => {
    const result = concat(
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5, 6]),
    );
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('handles empty arrays', () => {
    const result = concat(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2]));
    expect(Array.from(result)).toEqual([1, 2]);
  });
});

describe('equal', () => {
  it('returns true for identical arrays', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(equal(a, new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('returns false for different arrays', () => {
    expect(equal(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('AES-256-GCM', () => {
  it('encrypts and decrypts plaintext', async () => {
    const key = randomBytes(32);
    const plaintext = encode('Secret message');
    const { ciphertext, iv, tag } = await aesGcmEncrypt(plaintext, key);
    const decrypted = await aesGcmDecrypt(ciphertext, key, iv, tag);
    expect(decode(decrypted)).toBe('Secret message');
  });

  it('encrypts and decrypts with AAD', async () => {
    const key = randomBytes(32);
    const plaintext = encode('Authenticated data');
    const aad = encode('context');
    const { ciphertext, iv, tag } = await aesGcmEncrypt(plaintext, key, aad);
    const decrypted = await aesGcmDecrypt(ciphertext, key, iv, tag, aad);
    expect(decode(decrypted)).toBe('Authenticated data');
  });

  it('fails with wrong key', async () => {
    const key = randomBytes(32);
    const { ciphertext, iv, tag } = await aesGcmEncrypt(encode('test'), key);
    const wrongKey = randomBytes(32);
    await expect(aesGcmDecrypt(ciphertext, wrongKey, iv, tag)).rejects.toThrow();
  });

  it('fails with wrong AAD', async () => {
    const key = randomBytes(32);
    const aad = encode('correct');
    const { ciphertext, iv, tag } = await aesGcmEncrypt(encode('test'), key, aad);
    await expect(aesGcmDecrypt(ciphertext, key, iv, tag, encode('wrong'))).rejects.toThrow();
  });

  it('produces different ciphertext each time (random IV)', async () => {
    const key = randomBytes(32);
    const pt = encode('same');
    const a = await aesGcmEncrypt(pt, key);
    const b = await aesGcmEncrypt(pt, key);
    expect(equal(a.iv, b.iv)).toBe(false);
  });
});

describe('HKDF-SHA256', () => {
  it('derives the requested length', async () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(32);
    const info = encode('test');
    const key = await hkdf(ikm, salt, info, 32);
    expect(key.length).toBe(32);
  });

  it('is deterministic', async () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(32);
    const info = encode('ctx');
    const a = await hkdf(ikm, salt, info, 32);
    const b = await hkdf(ikm, salt, info, 32);
    expect(equal(a, b)).toBe(true);
  });

  it('produces different output for different info', async () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(32);
    const a = await hkdf(ikm, salt, encode('a'), 32);
    const b = await hkdf(ikm, salt, encode('b'), 32);
    expect(equal(a, b)).toBe(false);
  });
});

describe('HMAC-SHA256', () => {
  it('produces a 32-byte MAC', async () => {
    const mac = await hmacSha256(randomBytes(32), encode('data'));
    expect(mac.length).toBe(32);
  });

  it('is deterministic', async () => {
    const key = randomBytes(32);
    const data = encode('msg');
    const a = await hmacSha256(key, data);
    const b = await hmacSha256(key, data);
    expect(equal(a, b)).toBe(true);
  });
});

describe('SHA-256', () => {
  it('produces a 32-byte hash', async () => {
    const h = await sha256(encode('hello'));
    expect(h.length).toBe(32);
  });

  it('is deterministic', async () => {
    const a = await sha256(encode('test'));
    const b = await sha256(encode('test'));
    expect(equal(a, b)).toBe(true);
  });
});

describe('SHA-512', () => {
  it('produces a 64-byte hash', async () => {
    const h = await sha512(encode('hello'));
    expect(h.length).toBe(64);
  });
});

describe('PBKDF2', () => {
  it('derives a key of requested length', async () => {
    const key = await pbkdf2(encode('password'), randomBytes(16), 1000, 32);
    expect(key.length).toBe(32);
  });

  it('is deterministic with same inputs', async () => {
    const salt = randomBytes(16);
    const a = await pbkdf2(encode('pw'), salt, 1000, 32);
    const b = await pbkdf2(encode('pw'), salt, 1000, 32);
    expect(equal(a, b)).toBe(true);
  });

  it('differs with different passwords', async () => {
    const salt = randomBytes(16);
    const a = await pbkdf2(encode('pw1'), salt, 1000, 32);
    const b = await pbkdf2(encode('pw2'), salt, 1000, 32);
    expect(equal(a, b)).toBe(false);
  });
});

describe('X25519', () => {
  it('generates a key pair', async () => {
    const kp = await generateX25519KeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBeGreaterThan(0);
  });

  it('computes shared secret via DH', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await generateX25519KeyPair();
    const sharedA = await x25519DH(alice.privateKey, bob.publicKey);
    const sharedB = await x25519DH(bob.privateKey, alice.publicKey);
    expect(equal(sharedA, sharedB)).toBe(true);
    expect(sharedA.length).toBe(32);
  });
});

describe('Ed25519', () => {
  it('generates a key pair', async () => {
    const kp = await generateEd25519KeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBeGreaterThan(0);
  });

  it('signs and verifies', async () => {
    const kp = await generateEd25519KeyPair();
    const msg = encode('Sign this');
    const sig = await ed25519Sign(kp.privateKey, msg);
    expect(sig.length).toBe(64);
    const valid = await ed25519Verify(kp.publicKey, sig, msg);
    expect(valid).toBe(true);
  });

  it('rejects invalid signature', async () => {
    const kp = await generateEd25519KeyPair();
    const sig = await ed25519Sign(kp.privateKey, encode('original'));
    const valid = await ed25519Verify(kp.publicKey, sig, encode('tampered'));
    expect(valid).toBe(false);
  });

  it('rejects wrong public key', async () => {
    const kp1 = await generateEd25519KeyPair();
    const kp2 = await generateEd25519KeyPair();
    const sig = await ed25519Sign(kp1.privateKey, encode('test'));
    const valid = await ed25519Verify(kp2.publicKey, sig, encode('test'));
    expect(valid).toBe(false);
  });
});

describe('generateSafetyNumber', () => {
  it('produces a 12-group numeric string', async () => {
    const kp1 = await generateEd25519KeyPair();
    const kp2 = await generateEd25519KeyPair();
    const sn = await generateSafetyNumber(kp1.publicKey, kp2.publicKey);
    const groups = sn.split(' ');
    expect(groups.length).toBe(12);
    for (const g of groups) {
      expect(g).toMatch(/^\d{5}$/);
    }
  });

  it('is the same regardless of key order', async () => {
    const kp1 = await generateEd25519KeyPair();
    const kp2 = await generateEd25519KeyPair();
    const a = await generateSafetyNumber(kp1.publicKey, kp2.publicKey);
    const b = await generateSafetyNumber(kp2.publicKey, kp1.publicKey);
    expect(a).toBe(b);
  });
});
