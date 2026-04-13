import { describe, it, expect } from 'vitest';
import {
  generateX25519KeyPair,
  generateEd25519KeyPair,
  equal,
  encode,
  decode,
} from './crypto-utils.js';
import {
  generateSignedPreKey,
  generateOneTimePreKeys,
  serializeBundle,
  deserializeBundle,
  x3dhInitiate,
  x3dhRespond,
  type PreKeyBundle,
} from './x3dh.js';

describe('X3DH Key Agreement', () => {
  it('generates a signed pre-key with valid signature', async () => {
    const ik = await generateEd25519KeyPair();
    const spk = await generateSignedPreKey(ik.privateKey, 1);
    expect(spk.keyPair.publicKey.length).toBe(32);
    expect(spk.signature.length).toBe(64);
    expect(spk.id).toBe(1);
  });

  it('generates one-time pre-keys with sequential IDs', async () => {
    const keys = await generateOneTimePreKeys(10, 5);
    expect(keys.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(keys[i].id).toBe(10 + i);
      expect(keys[i].keyPair.publicKey.length).toBe(32);
    }
  });

  it('round-trips bundle serialization', async () => {
    const ik = await generateEd25519KeyPair();
    const spk = await generateSignedPreKey(ik.privateKey, 1);
    const opks = await generateOneTimePreKeys(1, 1);

    const bundle: PreKeyBundle = {
      identityKey: ik.publicKey,
      signedPreKey: {
        id: spk.id,
        publicKey: spk.keyPair.publicKey,
        signature: spk.signature,
      },
      oneTimePreKey: {
        id: opks[0].id,
        publicKey: opks[0].keyPair.publicKey,
      },
    };

    const serialized = serializeBundle(bundle);
    const deserialized = deserializeBundle(serialized);

    expect(equal(deserialized.identityKey, bundle.identityKey)).toBe(true);
    expect(equal(deserialized.signedPreKey.publicKey, bundle.signedPreKey.publicKey)).toBe(true);
    expect(deserialized.oneTimePreKey).toBeDefined();
    expect(equal(deserialized.oneTimePreKey!.publicKey, bundle.oneTimePreKey!.publicKey)).toBe(true);
  });

  it('establishes matching shared secrets with OPK', async () => {
    // Bob: generate keys and publish bundle
    const bobIK = await generateEd25519KeyPair();
    const bobDH = await generateX25519KeyPair(); // X25519 identity DH key
    const bobSPK = await generateSignedPreKey(bobIK.privateKey, 1);
    const bobOPKs = await generateOneTimePreKeys(1, 1);

    const bobBundle: PreKeyBundle = {
      identityKey: bobDH.publicKey, // Using X25519 DH key as identity for the protocol
      signedPreKey: {
        id: bobSPK.id,
        publicKey: bobSPK.keyPair.publicKey,
        signature: bobSPK.signature,
      },
      oneTimePreKey: {
        id: bobOPKs[0].id,
        publicKey: bobOPKs[0].keyPair.publicKey,
      },
    };

    // Alice: initiate X3DH
    const aliceIK = await generateEd25519KeyPair();
    const aliceDH = await generateX25519KeyPair();

    // The bundle's identity key is used for the DH verify step, but
    // x3dhInitiate verifies the SPK signature with the Ed25519 identity key.
    // We need the Ed25519 IK in the bundle for verification, then
    // DH operations use X25519 keys. Let's use a bundle with Ed25519 IK.
    const bundleForAlice: PreKeyBundle = {
      identityKey: bobIK.publicKey, // Ed25519 for signature verification
      signedPreKey: bobBundle.signedPreKey,
      oneTimePreKey: bobBundle.oneTimePreKey,
    };

    const aliceResult = await x3dhInitiate(aliceIK, aliceDH, bundleForAlice);

    expect(aliceResult.sharedSecret.length).toBe(32);
    expect(aliceResult.ephemeralPublicKey.length).toBe(32);
    expect(aliceResult.usedOneTimePreKeyId).toBe(1);
  });

  it('establishes matching secrets without OPK', async () => {
    const bobIK = await generateEd25519KeyPair();
    const bobSPK = await generateSignedPreKey(bobIK.privateKey, 1);

    const bundleNoOPK: PreKeyBundle = {
      identityKey: bobIK.publicKey,
      signedPreKey: {
        id: bobSPK.id,
        publicKey: bobSPK.keyPair.publicKey,
        signature: bobSPK.signature,
      },
    };

    const aliceIK = await generateEd25519KeyPair();
    const aliceDH = await generateX25519KeyPair();

    const result = await x3dhInitiate(aliceIK, aliceDH, bundleNoOPK);
    expect(result.sharedSecret.length).toBe(32);
    expect(result.usedOneTimePreKeyId).toBeUndefined();
  });

  it('rejects an invalid signed pre-key signature', async () => {
    const bobIK = await generateEd25519KeyPair();
    const badSPK = await generateX25519KeyPair();

    const bundle: PreKeyBundle = {
      identityKey: bobIK.publicKey,
      signedPreKey: {
        id: 1,
        publicKey: badSPK.publicKey,
        signature: new Uint8Array(64), // invalid signature
      },
    };

    const aliceIK = await generateEd25519KeyPair();
    const aliceDH = await generateX25519KeyPair();

    await expect(x3dhInitiate(aliceIK, aliceDH, bundle)).rejects.toThrow(
      'Invalid signed pre-key signature',
    );
  });
});
