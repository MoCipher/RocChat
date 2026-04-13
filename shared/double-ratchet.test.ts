import { describe, it, expect } from 'vitest';
import {
  generateX25519KeyPair,
  randomBytes,
  encode,
  decode,
  equal,
} from './crypto-utils.js';
import {
  initSender,
  initReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeState,
  deserializeState,
} from './double-ratchet.js';

describe('Double Ratchet', () => {
  async function setupSession() {
    const sharedSecret = randomBytes(32);
    const bobSPK = await generateX25519KeyPair();

    const aliceState = await initSender(sharedSecret, bobSPK.publicKey);
    const bobState = initReceiver(sharedSecret, bobSPK);

    return { aliceState, bobState };
  }

  it('encrypts and decrypts a single message', async () => {
    const { aliceState, bobState } = await setupSession();

    const encrypted = await ratchetEncrypt(aliceState, encode('Hello Bob!'));
    const decrypted = await ratchetDecrypt(bobState, encrypted);

    expect(decode(decrypted)).toBe('Hello Bob!');
  });

  it('handles multiple messages in sequence', async () => {
    const { aliceState, bobState } = await setupSession();

    const msgs = ['Message 1', 'Message 2', 'Message 3'];
    for (const msg of msgs) {
      const enc = await ratchetEncrypt(aliceState, encode(msg));
      const dec = await ratchetDecrypt(bobState, enc);
      expect(decode(dec)).toBe(msg);
    }
  });

  it('supports bidirectional messaging', async () => {
    const { aliceState, bobState } = await setupSession();

    // Alice → Bob
    const enc1 = await ratchetEncrypt(aliceState, encode('Hey Bob'));
    expect(decode(await ratchetDecrypt(bobState, enc1))).toBe('Hey Bob');

    // Bob → Alice
    const enc2 = await ratchetEncrypt(bobState, encode('Hi Alice'));
    expect(decode(await ratchetDecrypt(aliceState, enc2))).toBe('Hi Alice');

    // Alice → Bob again
    const enc3 = await ratchetEncrypt(aliceState, encode('How are you?'));
    expect(decode(await ratchetDecrypt(bobState, enc3))).toBe('How are you?');
  });

  it('handles out-of-order messages', async () => {
    const { aliceState, bobState } = await setupSession();

    const enc1 = await ratchetEncrypt(aliceState, encode('First'));
    const enc2 = await ratchetEncrypt(aliceState, encode('Second'));
    const enc3 = await ratchetEncrypt(aliceState, encode('Third'));

    // Decrypt out of order: 3, 1, 2
    expect(decode(await ratchetDecrypt(bobState, enc3))).toBe('Third');
    expect(decode(await ratchetDecrypt(bobState, enc1))).toBe('First');
    expect(decode(await ratchetDecrypt(bobState, enc2))).toBe('Second');
  });

  it('produces unique ciphertext for same plaintext', async () => {
    const { aliceState } = await setupSession();

    const enc1 = await ratchetEncrypt(aliceState, encode('same'));
    const enc2 = await ratchetEncrypt(aliceState, encode('same'));

    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('serializes and deserializes state', async () => {
    const { aliceState, bobState } = await setupSession();

    // Send a message to advance the ratchet
    const enc = await ratchetEncrypt(aliceState, encode('test'));
    await ratchetDecrypt(bobState, enc);

    // Serialize and deserialize Alice's state
    const serialized = serializeState(aliceState);
    const restored = deserializeState(serialized);

    // Use restored state to send another message
    const enc2 = await ratchetEncrypt(restored, encode('after restore'));
    const dec2 = await ratchetDecrypt(bobState, enc2);
    expect(decode(dec2)).toBe('after restore');
  });

  it('fails to decrypt with wrong session', async () => {
    const { aliceState } = await setupSession();
    const otherShared = randomBytes(32);
    const otherSPK = await generateX25519KeyPair();
    const wrongBob = initReceiver(otherShared, otherSPK);

    const enc = await ratchetEncrypt(aliceState, encode('secret'));
    await expect(ratchetDecrypt(wrongBob, enc)).rejects.toThrow();
  });
});
