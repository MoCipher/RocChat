import { describe, it, expect } from 'vitest';
import { encode, decode, equal } from './crypto-utils.js';
import {
  generateSenderKey,
  createDistribution,
  importDistribution,
  senderKeyEncrypt,
  senderKeyDecrypt,
  serializeSenderKey,
  deserializeSenderKey,
} from './sender-keys.js';

describe('Sender Keys (Group E2E)', () => {
  it('generates a sender key', () => {
    const key = generateSenderKey();
    expect(key.chainKey.length).toBe(32);
    expect(key.signingKey.length).toBe(32);
    expect(key.iteration).toBe(0);
  });

  it('creates and imports a distribution', () => {
    const key = generateSenderKey();
    const dist = createDistribution('alice', 'group1', key);
    expect(dist.senderId).toBe('alice');
    expect(dist.groupId).toBe('group1');

    const imported = importDistribution(dist);
    expect(equal(imported.chainKey, key.chainKey)).toBe(true);
    expect(equal(imported.signingKey, key.signingKey)).toBe(true);
    expect(imported.iteration).toBe(0);
  });

  it('encrypts and decrypts a group message', async () => {
    const senderKey = generateSenderKey();
    const receiverKey = generateSenderKey();
    // Receiver has sender's key via distribution
    const dist = createDistribution('alice', 'group1', senderKey);
    let bobKey = importDistribution(dist);

    const { ciphertext, updatedKey } = await senderKeyEncrypt(
      'alice',
      senderKey,
      encode('Hello group!'),
    );

    const { plaintext, updatedKey: bobUpdated } = await senderKeyDecrypt(bobKey, ciphertext);
    expect(decode(plaintext)).toBe('Hello group!');
  });

  it('handles multiple sequential messages', async () => {
    let aliceKey = generateSenderKey();
    const dist = createDistribution('alice', 'g1', aliceKey);
    let bobKey = importDistribution(dist);

    for (const msg of ['First', 'Second', 'Third']) {
      const { ciphertext, updatedKey } = await senderKeyEncrypt('alice', aliceKey, encode(msg));
      aliceKey = updatedKey;

      const { plaintext, updatedKey: bu } = await senderKeyDecrypt(bobKey, ciphertext);
      bobKey = bu;

      expect(decode(plaintext)).toBe(msg);
    }
  });

  it('serializes and deserializes a sender key', () => {
    const key = generateSenderKey();
    const json = serializeSenderKey(key);
    const restored = deserializeSenderKey(json);
    expect(equal(restored.chainKey, key.chainKey)).toBe(true);
    expect(equal(restored.signingKey, key.signingKey)).toBe(true);
    expect(restored.iteration).toBe(key.iteration);
  });

  it('ratchets chain key forward', async () => {
    let key = generateSenderKey();
    const originalChain = new Uint8Array(key.chainKey);

    const { updatedKey } = await senderKeyEncrypt('alice', key, encode('msg'));
    expect(equal(updatedKey.chainKey, originalChain)).toBe(false);
    expect(updatedKey.iteration).toBe(1);
  });
});
