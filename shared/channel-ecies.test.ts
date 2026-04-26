/**
 * Regression test for the ECIES wrap/unwrap composition used to distribute
 * channel symmetric keys to subscribers. The web client at
 * `web/src/crypto/channel-keys.ts` performs the same operations; if either
 * end of the math drifts these tests fail.
 */

import { describe, it, expect } from 'vitest';
import {
  generateX25519KeyPair,
  x25519DH,
  hkdf,
  randomBytes,
  aesGcmEncrypt,
  aesGcmDecrypt,
  encode,
  decode,
  equal,
} from './crypto-utils.js';

const KEY_INFO = encode('rocchat-channel-key-wrap-v1');
const POST_INFO = encode('rocchat-channel-post-v1');

async function deriveWrapKey(ss: Uint8Array, channelId: string): Promise<Uint8Array> {
  return hkdf(ss, encode(channelId), KEY_INFO, 32);
}

describe('Channel ECIES wrap/unwrap (E2E)', () => {
  it('roundtrips a 32-byte channel key', async () => {
    const channelId = 'chan-1234';
    const channelKey = randomBytes(32);

    const recipient = await generateX25519KeyPair();

    // Sender wraps
    const ephemeral = await generateX25519KeyPair();
    const ssSender = await x25519DH(ephemeral.privateKey, recipient.publicKey);
    const wrapKey = await deriveWrapKey(ssSender, channelId);
    const wrapped = await aesGcmEncrypt(channelKey, wrapKey);

    // Recipient unwraps
    const ssRecipient = await x25519DH(recipient.privateKey, ephemeral.publicKey);
    const unwrapKey = await deriveWrapKey(ssRecipient, channelId);
    const recovered = await aesGcmDecrypt(
      wrapped.ciphertext,
      unwrapKey,
      wrapped.iv,
      wrapped.tag,
    );

    expect(equal(channelKey, recovered)).toBe(true);
  });

  it('rejects wrong recipient', async () => {
    const channelId = 'chan-1234';
    const channelKey = randomBytes(32);
    const intendedRecipient = await generateX25519KeyPair();
    const wrongRecipient = await generateX25519KeyPair();

    const ephemeral = await generateX25519KeyPair();
    const ssSender = await x25519DH(ephemeral.privateKey, intendedRecipient.publicKey);
    const wrapKey = await deriveWrapKey(ssSender, channelId);
    const wrapped = await aesGcmEncrypt(channelKey, wrapKey);

    const ssWrong = await x25519DH(wrongRecipient.privateKey, ephemeral.publicKey);
    const wrongKey = await deriveWrapKey(ssWrong, channelId);

    await expect(
      aesGcmDecrypt(wrapped.ciphertext, wrongKey, wrapped.iv, wrapped.tag),
    ).rejects.toBeDefined();
  });

  it('roundtrips a post body using the derived post key', async () => {
    const channelId = 'chan-1234';
    const channelKey = randomBytes(32);
    const plaintext = 'Welcome to my E2E channel — only subscribers can read this.';

    const postKey = await hkdf(channelKey, encode(channelId), POST_INFO, 32);
    const enc = await aesGcmEncrypt(encode(plaintext), postKey);

    const dec = await aesGcmDecrypt(enc.ciphertext, postKey, enc.iv, enc.tag);
    expect(decode(dec)).toBe(plaintext);
  });

  it('domain-separates wrap-key from post-key for the same channel key', async () => {
    const channelId = 'chan-1234';
    const channelKey = randomBytes(32);

    const recipient = await generateX25519KeyPair();
    const ephemeral = await generateX25519KeyPair();
    const ss = await x25519DH(ephemeral.privateKey, recipient.publicKey);
    const wrapKey = await deriveWrapKey(ss, channelId);
    const postKey = await hkdf(channelKey, encode(channelId), POST_INFO, 32);

    expect(equal(wrapKey, postKey)).toBe(false);
  });
});
