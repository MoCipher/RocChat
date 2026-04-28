/**
 * RocChat — Protocol Message Types
 *
 * Defines the wire format for all encrypted message payloads.
 * These types represent the PLAINTEXT content inside encrypted envelopes.
 */

// ── Message Types ──

export type MessageType =
  | 'text'
  | 'file'
  | 'voice_note'
  | 'image'
  | 'video'
  | 'location'
  | 'contact'
  | 'vault_item'
  | 'read_receipt'
  | 'typing'
  | 'presence'
  | 'call_offer'
  | 'call_answer'
  | 'call_ice'
  | 'call_end'
  | 'meeting_event'
  | 'key_change'
  | 'disappear_config'
  | 'group_update';

// ── Plaintext Message Payloads ──

export interface TextMessage {
  type: 'text';
  body: string;
  timestamp: number;
  replyTo?: string; // message ID being replied to
  editOf?: string; // message ID being edited
}

export interface FileMessage {
  type: 'file' | 'image' | 'video' | 'voice_note';
  blobId: string; // R2 blob reference
  fileKey: string; // base64 AES-256 key for decrypting the blob
  fileIv: string; // base64 IV
  fileHash: string; // base64 SHA-256 of plaintext for integrity
  filename: string;
  mime: string;
  size: number;
  duration?: number; // for audio/video
  width?: number; // for images/video
  height?: number; // for images/video
  thumbnail?: {
    blobId: string;
    fileKey: string;
    fileIv: string;
    width: number;
    height: number;
  };
  timestamp: number;
  viewOnce?: boolean; // Premium feature: disappears after viewed
  caption?: string;
}

export interface VaultItemMessage {
  type: 'vault_item';
  vaultType: 'password' | 'note' | 'card' | 'wifi' | 'file';
  label: string;
  encryptedPayload: string; // base64 AES-GCM encrypted vault data
  expiresAt?: number; // auto-expire timestamp
  viewOnce?: boolean;
  timestamp: number;
}

export interface ReadReceiptMessage {
  type: 'read_receipt';
  messageIds: string[];
  timestamp: number;
}

export interface TypingMessage {
  type: 'typing';
  isTyping: boolean;
}

export interface PresenceMessage {
  type: 'presence';
  status: 'online' | 'offline' | 'away';
  lastSeen?: number;
}

// ── Call Signaling ──

export interface CallOfferMessage {
  type: 'call_offer';
  callId: string;
  callType: 'voice' | 'video';
  sdp: string;
  timestamp: number;
}

export interface CallAnswerMessage {
  type: 'call_answer';
  callId: string;
  sdp: string;
  timestamp: number;
}

export interface CallIceMessage {
  type: 'call_ice';
  callId: string;
  candidate: string;
  sdpMLineIndex: number;
  sdpMid: string;
}

export interface CallEndMessage {
  type: 'call_end';
  callId: string;
  reason: 'hangup' | 'declined' | 'busy' | 'timeout' | 'error';
  duration?: number;
  timestamp: number;
}

// ── Meeting Control Plane ──

export type MeetingRole = 'host' | 'moderator' | 'participant' | 'viewer';
export type MeetingStatus = 'scheduled' | 'live' | 'ended';
export type MeetingMediaMode = 'mesh' | 'sfu';

export interface MeetingEventMessage {
  type: 'meeting_event';
  meetingId: string;
  action:
    | 'join'
    | 'leave'
    | 'raise_hand'
    | 'lower_hand'
    | 'host_mute_all'
    | 'host_lock_room'
    | 'host_unlock_room'
    | 'host_remove_participant'
    | 'lobby_admit'
    | 'lobby_deny';
  actorUserId: string;
  targetUserId?: string;
  role?: MeetingRole;
  mediaMode?: MeetingMediaMode;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Group Management ──

export interface DisappearConfigMessage {
  type: 'disappear_config';
  messages?: number; // seconds, 0 = off
  media?: number;
  timestamp: number;
}

export interface GroupUpdateMessage {
  type: 'group_update';
  action: 'create' | 'add_member' | 'remove_member' | 'change_name' | 'change_avatar' | 'change_admin';
  groupName?: string;
  members?: string[]; // user IDs
  targetUserId?: string;
  timestamp: number;
}

// ── Union type for all plaintext payloads ──

export type PlaintextPayload =
  | TextMessage
  | FileMessage
  | VaultItemMessage
  | ReadReceiptMessage
  | TypingMessage
  | PresenceMessage
  | CallOfferMessage
  | CallAnswerMessage
  | CallIceMessage
  | CallEndMessage
  | MeetingEventMessage
  | DisappearConfigMessage
  | GroupUpdateMessage;

// ── Wire Envelope (sent to server, encrypted) ──

export interface MessageEnvelope {
  id: string; // unique message ID
  senderId: string; // user UUID
  conversationId: string; // conversation UUID
  /** Encrypted Double Ratchet message */
  encrypted: {
    header: {
      dhPublicKey: string;
      pn: number;
      n: number;
    };
    ciphertext: string;
    iv: string;
    tag: string;
  };
  /** Server-assigned arrival timestamp */
  serverTimestamp?: number;
}

// ── Conversation Types ──

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  /** Encrypted metadata blob (group name, avatar, etc.) — only for groups */
  encryptedMeta?: string;
  createdAt: number;
}

// ── User/Device Types ──

export interface UserPublicInfo {
  userId: string;
  username: string;
  displayName?: string;
  identityKey: string; // base64 Ed25519 public key
  avatarBlobId?: string;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: 'ios' | 'android' | 'web' | 'desktop';
  lastActive: number;
  pushToken?: string;
}

// ── API Request/Response types ──

export interface RegisterRequest {
  username: string;
  displayName: string;
  authHash: string; // base64 PBKDF2/Argon2 hash
  salt: string; // base64
  encryptedKeys: string; // base64 AES-GCM encrypted private key blob
  identityKey: string; // base64 Ed25519 public key
  identityDHKey: string; // base64 X25519 public key for X3DH
  signedPreKey: {
    id: number;
    publicKey: string;
    signature: string;
  };
  oneTimePreKeys: Array<{
    id: number;
    publicKey: string;
  }>;
  powToken?: string;
  powNonce?: string;
}

export interface LoginRequest {
  username: string;
  authHash: string; // base64
}

export interface LoginResponse {
  userId: string;
  sessionToken: string;
  encryptedKeys: string; // base64
  salt: string; // base64
}

export interface SendMessageRequest {
  conversationId: string;
  encrypted: MessageEnvelope['encrypted'];
}
