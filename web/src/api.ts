/**
 * RocChat Web — API Client
 *
 * Handles all HTTP calls to the Worker backend.
 */

const BASE = '/api';

let sessionToken: string | null = localStorage.getItem('rocchat_token');

export function setToken(token: string | null) {
  sessionToken = token;
  if (token) localStorage.setItem('rocchat_token', token);
  else localStorage.removeItem('rocchat_token');
}

export function getToken(): string | null {
  return sessionToken;
}

async function req<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T }> {
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> || {}),
  };

  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const data = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : await res.text();

  return { ok: res.ok, status: res.status, data: data as T };
}

// ── Auth ──

export function register(body: {
  username: string;
  display_name: string;
  auth_hash: string;
  salt: string;
  identity_key: string;
  identity_dh_key?: string;
  identity_private_encrypted: string;
  signed_pre_key_public: string;
  signed_pre_key_private_encrypted: string;
  signed_pre_key_signature: string;
  one_time_pre_keys: string[];
  turnstile_token: string;
}) {
  return req('/auth/register', { method: 'POST', body: JSON.stringify(body) });
}

export function login(body: { username: string; auth_hash: string }) {
  return req<{
    session_token: string;
    user_id: string;
    encrypted_keys: string;
    identity_key: string;
    salt: string;
    signed_pre_key_public: string | null;
  }>('/auth/login', { method: 'POST', body: JSON.stringify(body) });
}

// ── Messages ──

export function getConversations() {
  return req<{ conversations: Conversation[] }>('/messages/conversations');
}

export function getMessages(conversationId: string, cursor?: string) {
  let path = `/messages/${conversationId}`;
  if (cursor) path += `?cursor=${cursor}`;
  return req<{ messages: Message[]; nextCursor?: string }>(path);
}

export function sendMessage(body: {
  conversation_id: string;
  ciphertext: string;
  iv: string;
  ratchet_header: string;
  message_type?: string;
  expires_in?: number;
}) {
  return req('/messages/send', { method: 'POST', body: JSON.stringify(body) });
}

export function createConversation(body: {
  type: 'direct' | 'group';
  member_ids: string[];
  name?: string;
}) {
  return req<{ conversation_id: string }>('/messages/conversations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── Contacts ──

export function searchUsers(query: string) {
  return req<{ results: UserResult[] }>(`/contacts/search?q=${encodeURIComponent(query)}`);
}

export function addContact(userId: string) {
  return req('/contacts/add', { method: 'POST', body: JSON.stringify({ userId }) });
}

export function getContacts() {
  return req<{ contacts: Contact[] }>('/contacts');
}

export function blockContact(userId: string, blocked = true) {
  return req('/contacts/block', { method: 'POST', body: JSON.stringify({ userId, blocked }) });
}

// ── Keys ──

export function getPreKeyBundle(userId: string) {
  return req(`/keys/bundle/${userId}`);
}

// ── Profile ──

export function getMe() {
  return req<UserProfile>('/me');
}

export function updateSettings(settings: Record<string, unknown>) {
  return req('/me/settings', { method: 'PATCH', body: JSON.stringify(settings) });
}

// ── Devices ──

export function getDevices() {
  return req<Device[]>('/devices');
}

export function deleteDevice(deviceId: string) {
  return req(`/devices/${deviceId}`, { method: 'DELETE' });
}

// ── Keys ──

export function getPreKeyCount() {
  return req<{ count: number }>('/keys/count');
}

export function uploadPreKeys(keys: { id: number; publicKey: string }[]) {
  return req('/keys/prekeys', { method: 'POST', body: JSON.stringify({ preKeys: keys }) });
}

export function health() {
  return req('/health');
}

// ── Push Notifications ──

export function registerPushToken(token: string, platform: 'apns' | 'fcm' | 'web') {
  return req('/push/register', { method: 'POST', body: JSON.stringify({ token, platform }) });
}

// ── QR Auth ──

export function generateQrToken() {
  return req<{ token: string; expires_in: number }>('/auth/qr/generate', { method: 'POST' });
}

export function pollQrToken(token: string) {
  return req<{
    status: string;
    session_token?: string;
    user_id?: string;
    encrypted_keys?: string;
    identity_key?: string;
  }>(`/auth/qr/poll/${token}`);
}

export function authorizeQrToken(qrToken: string) {
  return req('/auth/qr/authorize', { method: 'POST', body: JSON.stringify({ qr_token: qrToken }) });
}

// ── Types ──

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name?: string;
  members: { user_id: string; username: string; display_name: string }[];
  last_message_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  iv: string;
  ratchet_header: string;
  message_type: string;
  created_at: string;
}

export interface UserResult {
  userId: string;
  username: string;
  displayName: string;
  identityKey: string;
}

export interface Contact {
  userId: string;
  username: string;
  displayName: string;
  identityKey: string;
  verified: boolean;
  blocked: boolean;
  addedAt: string;
}

export interface UserProfile {
  id: string;
  username: string;
  display_name: string;
  identity_key: string;
  discoverable: boolean;
  created_at: string;
  show_read_receipts?: number;
  show_typing_indicator?: number;
  show_online_to?: string;
  who_can_add?: string;
  default_disappear_timer?: number | null;
}

export interface Device {
  id: string;
  device_name: string;
  platform: string;
  last_active: number;
  created_at: number;
}
