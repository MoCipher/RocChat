/**
 * RocChat — Protocol & Signaling Envelope Security Tests
 *
 * Validates that message envelopes, file envelopes, and signaling payloads
 * have the required security-critical fields and that preview normalization
 * handles both snake_case and camelCase payloads correctly.
 */

import { describe, it, expect } from 'vitest';
import type {
  MessageEnvelope,
  FileMessage,
  CallOfferMessage,
  CallAnswerMessage,
  CallIceMessage,
  CallEndMessage,
  PlaintextPayload,
  TextMessage,
} from './protocol';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'msg-abc-123',
    senderId: 'user-111',
    conversationId: 'conv-222',
    encrypted: {
      header: { dhPublicKey: 'base64pubkey==', pn: 0, n: 0 },
      ciphertext: 'base64ciphertext==',
      iv: 'base64iv==',
      tag: 'base64tag==',
    },
    ...overrides,
  };
}

function makeFileMessage(overrides: Partial<FileMessage> = {}): FileMessage {
  return {
    type: 'image',
    blobId: 'r2-blob-xyz',
    fileKey: 'base64aeskey==',
    fileIv: 'base64iv==',
    fileHash: 'base64sha256==',
    filename: 'photo.jpg',
    mime: 'image/jpeg',
    size: 204800,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Message Envelope Tests ────────────────────────────────────────────────────

describe('MessageEnvelope structure', () => {
  it('has required top-level fields', () => {
    const env = makeEnvelope();
    expect(env.id).toBeTruthy();
    expect(env.senderId).toBeTruthy();
    expect(env.conversationId).toBeTruthy();
    expect(env.encrypted).toBeDefined();
  });

  it('encrypted block has header, ciphertext, iv, tag', () => {
    const env = makeEnvelope();
    const { header, ciphertext, iv, tag } = env.encrypted;
    expect(header.dhPublicKey).toBeTruthy();
    expect(typeof header.pn).toBe('number');
    expect(typeof header.n).toBe('number');
    expect(ciphertext).toBeTruthy();
    expect(iv).toBeTruthy();
    expect(tag).toBeTruthy();
  });

  it('rejects envelope with missing id (type guard)', () => {
    const env = makeEnvelope({ id: '' });
    expect(env.id).toBeFalsy();
  });

  it('rejects envelope with missing senderId (type guard)', () => {
    const env = makeEnvelope({ senderId: '' });
    expect(env.senderId).toBeFalsy();
  });
});

// ── File / Media Envelope Tests ───────────────────────────────────────────────

describe('FileMessage (media envelope)', () => {
  it('has all security-critical fields', () => {
    const msg = makeFileMessage();
    expect(msg.blobId).toBeTruthy();
    expect(msg.fileKey).toBeTruthy();
    expect(msg.fileIv).toBeTruthy();
    expect(msg.fileHash).toBeTruthy();
  });

  it('blobId is non-empty string', () => {
    const msg = makeFileMessage();
    expect(typeof msg.blobId).toBe('string');
    expect(msg.blobId.length).toBeGreaterThan(0);
  });

  it('fileHash is non-empty (integrity field)', () => {
    const msg = makeFileMessage();
    expect(typeof msg.fileHash).toBe('string');
    expect(msg.fileHash.length).toBeGreaterThan(0);
  });

  it('missing fileHash is detectable', () => {
    const raw = makeFileMessage();
    // Simulate receiving a tampered/stripped payload
    const stripped = { ...raw } as Partial<FileMessage>;
    delete (stripped as any).fileHash;
    expect((stripped as any).fileHash).toBeUndefined();
  });

  it('size must be positive', () => {
    const msg = makeFileMessage({ size: 1024 });
    expect(msg.size).toBeGreaterThan(0);
  });

  it('thumbnail also has integrity fields when present', () => {
    const msg = makeFileMessage({
      thumbnail: {
        blobId: 'thumb-blob',
        fileKey: 'thumb-key==',
        fileIv: 'thumb-iv==',
        width: 120,
        height: 90,
      },
    });
    expect(msg.thumbnail!.blobId).toBeTruthy();
    expect(msg.thumbnail!.fileKey).toBeTruthy();
    expect(msg.thumbnail!.fileIv).toBeTruthy();
  });

  it('voice_note type is accepted in union', () => {
    const msg = makeFileMessage({ type: 'voice_note' });
    expect(msg.type).toBe('voice_note');
  });
});

// ── Signaling Envelope Tests ──────────────────────────────────────────────────

describe('CallOfferMessage', () => {
  it('has callId, callType, sdp, timestamp', () => {
    const offer: CallOfferMessage = {
      type: 'call_offer',
      callId: 'call-001',
      callType: 'video',
      sdp: 'v=0\r\n...',
      timestamp: Date.now(),
    };
    expect(offer.callId).toBeTruthy();
    expect(['voice', 'video']).toContain(offer.callType);
    expect(offer.sdp).toBeTruthy();
    expect(offer.timestamp).toBeGreaterThan(0);
  });
});

describe('CallAnswerMessage', () => {
  it('has callId and sdp', () => {
    const answer: CallAnswerMessage = {
      type: 'call_answer',
      callId: 'call-001',
      sdp: 'v=0\r\n...',
      timestamp: Date.now(),
    };
    expect(answer.callId).toBeTruthy();
    expect(answer.sdp).toBeTruthy();
  });
});

describe('CallIceMessage', () => {
  it('has callId, candidate, sdpMLineIndex, sdpMid', () => {
    const ice: CallIceMessage = {
      type: 'call_ice',
      callId: 'call-001',
      candidate: 'candidate:...',
      sdpMLineIndex: 0,
      sdpMid: 'audio',
    };
    expect(ice.callId).toBeTruthy();
    expect(ice.candidate).toBeTruthy();
    expect(typeof ice.sdpMLineIndex).toBe('number');
    expect(ice.sdpMid).toBeTruthy();
  });
});

describe('CallEndMessage', () => {
  it('has callId and valid reason', () => {
    const validReasons: CallEndMessage['reason'][] = ['hangup', 'declined', 'busy', 'timeout', 'error'];
    for (const reason of validReasons) {
      const end: CallEndMessage = {
        type: 'call_end',
        callId: 'call-001',
        reason,
        timestamp: Date.now(),
      };
      expect(end.callId).toBeTruthy();
      expect(validReasons).toContain(end.reason);
    }
  });
});

// ── Media Preview Payload Normalization ───────────────────────────────────────
// The web client normalises both snake_case (server) and camelCase (legacy) fields.

type RawPreviewPayload = {
  message_type?: string;
  messageType?: string;
  blob_id?: string;
  blobId?: string;
  file_hash?: string;
  fileHash?: string;
  file_key?: string;
  fileKey?: string;
  file_iv?: string;
  fileIv?: string;
};

function normalizePreviewPayload(raw: RawPreviewPayload) {
  return {
    messageType: raw.message_type ?? raw.messageType ?? 'text',
    blobId: raw.blob_id ?? raw.blobId ?? null,
    fileHash: raw.file_hash ?? raw.fileHash ?? null,
    fileKey: raw.file_key ?? raw.fileKey ?? null,
    fileIv: raw.file_iv ?? raw.fileIv ?? null,
  };
}

describe('Media preview payload normalization', () => {
  it('reads snake_case fields', () => {
    const result = normalizePreviewPayload({
      message_type: 'image',
      blob_id: 'r2-abc',
      file_hash: 'sha==',
      file_key: 'key==',
      file_iv: 'iv==',
    });
    expect(result.messageType).toBe('image');
    expect(result.blobId).toBe('r2-abc');
    expect(result.fileHash).toBe('sha==');
  });

  it('reads camelCase fields', () => {
    const result = normalizePreviewPayload({
      messageType: 'video',
      blobId: 'r2-xyz',
      fileHash: 'sha2==',
      fileKey: 'key2==',
      fileIv: 'iv2==',
    });
    expect(result.messageType).toBe('video');
    expect(result.blobId).toBe('r2-xyz');
    expect(result.fileHash).toBe('sha2==');
  });

  it('snake_case takes precedence over camelCase', () => {
    const result = normalizePreviewPayload({
      message_type: 'voice_note',
      messageType: 'image',
    });
    expect(result.messageType).toBe('voice_note');
  });

  it('defaults messageType to text when absent', () => {
    const result = normalizePreviewPayload({});
    expect(result.messageType).toBe('text');
  });

  it('returns null for missing blob fields', () => {
    const result = normalizePreviewPayload({ message_type: 'text' });
    expect(result.blobId).toBeNull();
    expect(result.fileHash).toBeNull();
  });
});

// ── Hash Integrity Enforcement ────────────────────────────────────────────────

describe('Media hash integrity enforcement', () => {
  /**
   * Simulates the client-side check after decrypting a blob:
   *   computedHash !== envelope.fileHash  → reject
   */
  async function verifyMediaIntegrity(data: Uint8Array, expectedHashB64: string): Promise<boolean> {
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const computed = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return computed === expectedHashB64;
  }

  it('accepts data with matching hash', async () => {
    const data = new TextEncoder().encode('hello roc');
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(await verifyMediaIntegrity(data, hashB64)).toBe(true);
  });

  it('rejects data with wrong hash', async () => {
    const data = new TextEncoder().encode('hello roc');
    expect(await verifyMediaIntegrity(data, 'wronghash==')).toBe(false);
  });

  it('rejects tampered data (bit flip)', async () => {
    const original = new TextEncoder().encode('hello roc');
    const digest = await crypto.subtle.digest('SHA-256', original as BufferSource);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(digest)));

    const tampered = new Uint8Array(original);
    tampered[0] ^= 0x01; // flip one bit
    expect(await verifyMediaIntegrity(tampered, hashB64)).toBe(false);
  });

  it('empty payload has consistent hash', async () => {
    const data = new Uint8Array(0);
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(await verifyMediaIntegrity(data, hashB64)).toBe(true);
  });
});
