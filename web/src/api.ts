/**
 * RocChat Web — API Client
 *
 * Handles all HTTP calls to the Worker backend.
 * Supports access-token + refresh-token rotation and typed error codes.
 */

const BASE = '/api';

let sessionToken: string | null = localStorage.getItem('rocchat_token');
let refreshToken: string | null = localStorage.getItem('rocchat_refresh_token');

export function setToken(token: string | null) {
  sessionToken = token;
  if (token) localStorage.setItem('rocchat_token', token);
  else localStorage.removeItem('rocchat_token');
}

export function setRefreshToken(token: string | null) {
  refreshToken = token;
  if (token) localStorage.setItem('rocchat_refresh_token', token);
  else localStorage.removeItem('rocchat_refresh_token');
}

export function getToken(): string | null {
  return sessionToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

/** Structured error codes returned by the backend. */
export type ApiErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'CSRF_BLOCKED'
  | 'NOT_FOUND' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA'
  | 'RATE_LIMITED' | 'BANNED' | 'POW_REQUIRED' | 'POW_INVALID'
  | 'WEAK_KDF' | 'INTERNAL' | 'NETWORK';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  code?: ApiErrorCode;
  data: T;
}

/** Exchange the stored refresh token for a new access token. Single-flight. */
let refreshInFlight: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        setToken(null);
        setRefreshToken(null);
        return false;
      }
      const body = await res.json() as { session_token?: string; refresh_token?: string };
      if (body.session_token) setToken(body.session_token);
      if (body.refresh_token) setRefreshToken(body.refresh_token);
      return !!body.session_token;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function req<T = unknown>(
  path: string,
  opts: RequestInit = {},
  _retry = true,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> || {}),
  };
  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...opts, headers });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', data: { error: 'network' } as unknown as T };
  }

  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();

  // Auto-refresh on 401 with valid refresh token
  if (res.status === 401 && _retry && refreshToken) {
    const ok = await tryRefresh();
    if (ok) return req<T>(path, opts, false);
  }

  const code = (isJson && (data as { code?: string }).code) as ApiErrorCode | undefined;
  return { ok: res.ok, status: res.status, code, data: data as T };
}

// ── Auth ──

export function get(path: string) {
  return req(path);
}

export function put(path: string, body: unknown) {
  return req(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function del(path: string) {
  return req(path, { method: 'DELETE' });
}

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
  pow_token?: string;
  pow_nonce?: string;
}) {
  return req('/auth/register', { method: 'POST', body: JSON.stringify(body) });
}

export function login(body: { username: string; auth_hash: string; pow_token?: string; pow_nonce?: string }) {
  return req<{
    session_token: string;
    refresh_token?: string;
    expires_at?: number;
    refresh_expires_at?: number;
    user_id: string;
    device_id: string;
    encrypted_keys: string;
    identity_key: string;
    salt: string;
    signed_pre_key_public: string | null;
  }>('/auth/login', { method: 'POST', body: JSON.stringify(body) });
}

export function logout() {
  return req('/auth/logout', { method: 'POST' });
}

export function deleteAccount() {
  return req('/me', { method: 'DELETE' });
}

export function exportData() {
  return req<{ export: any }>('/me/export');
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
  tag?: string;
  ratchet_header: string;
  message_type?: string;
  expires_in?: number;
  reply_to?: string;
}) {
  return req('/messages/send', { method: 'POST', body: JSON.stringify(body) });
}

export function createConversation(body: {
  type: 'direct' | 'group';
  member_ids: string[];
  name?: string;
  encrypted_meta?: string;
}) {
  return req<{ conversation_id: string }>('/messages/conversations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteConversation(conversationId: string) {
  return req<void>(`/messages/conversations/${conversationId}`, { method: 'DELETE' });
}

export function muteConversation(conversationId: string) {
  return req<{ muted: boolean }>(`/messages/conversations/${conversationId}/mute`, { method: 'POST' });
}

export function setNotificationMode(conversationId: string, mode: string) {
  return req<{ notification_mode: string }>(`/messages/conversations/${conversationId}/notification-mode`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}

export function archiveConversation(conversationId: string) {
  return req<{ archived: boolean }>(`/messages/conversations/${conversationId}/archive`, { method: 'POST' });
}

export function pinConversation(conversationId: string) {
  return req<{ pinned: boolean }>(`/messages/conversations/${conversationId}/pin`, { method: 'POST' });
}

export function setConversationTheme(conversationId: string, theme: string | null) {
  return req<{ chat_theme: string | null }>(`/messages/conversations/${conversationId}/theme`, {
    method: 'PUT',
    body: JSON.stringify({ theme }),
  });
}

// ── Message Reactions ──

export function addReaction(messageId: string, encryptedReaction: string) {
  return req(`/messages/${messageId}/react`, {
    method: 'POST',
    body: JSON.stringify({ encrypted_reaction: encryptedReaction }),
  });
}

export function removeReaction(messageId: string) {
  return req(`/messages/${messageId}/react`, { method: 'DELETE' });
}

export function getReactions(messageId: string) {
  return req(`/messages/${messageId}/reactions`);
}

// ── Message Edit & Delete ──

export function editMessage(messageId: string, encrypted: string) {
  return req(`/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ encrypted }),
  });
}

export function deleteMessage(messageId: string) {
  return req(`/messages/${messageId}`, { method: 'DELETE' });
}

// ── Pinned Messages ──

export function pinMessage(conversationId: string, messageId: string) {
  return req(`/messages/conversations/${conversationId}/pin/${messageId}`, { method: 'POST' });
}

export function unpinMessage(conversationId: string, messageId: string) {
  return req(`/messages/conversations/${conversationId}/pin/${messageId}`, { method: 'DELETE' });
}

export function getPinnedMessages(conversationId: string) {
  return req(`/messages/conversations/${conversationId}/pins`);
}

// ── Chat Import ──

export function importMessages(source: string, conversationId: string, messages: Array<{ sender_name: string; body: string; timestamp: string }>) {
  return req<{ imported: number; source: string }>('/features/import', {
    method: 'POST',
    body: JSON.stringify({ source, conversation_id: conversationId, messages }),
  });
}

// ── Billing ──

export function createCheckout(type: 'donation' | 'business', amount?: number) {
  return createCryptoCheckout(type, amount);
}

export function createCryptoCheckout(type: 'donation' | 'business', amount?: number, recurring = false) {
  return req<{
    id: string;
    checkout_type: string;
    amount_usd_cents: number;
    crypto_symbol: string;
    amount_crypto: string;
    wallet_address: string;
    memo: string;
    status: string;
  }>('/billing/crypto/checkout', {
    method: 'POST',
    body: JSON.stringify({ type, amount, recurring }),
  });
}

export function confirmCryptoCheckout(intent_id: string, tx_hash: string) {
  return req<{ ok: boolean }>('/billing/crypto/confirm', {
    method: 'POST',
    body: JSON.stringify({ intent_id, tx_hash }),
  });
}

// No Apple IAP or Google Play — crypto donations only.

export function getPowChallenge() {
  return req<{ token: string; challenge: string; difficulty: number; expires_in: number }>('/features/pow/challenge');
}

export interface TransparencyReport {
  id: string;
  period_start: number;
  period_end: number;
  published_at: number;
  requests_received: number;
  requests_complied: number;
  accounts_affected: number;
  notes?: string;
  signed_by: string;
}

export interface SupporterWallEntry {
  id: string;
  username: string;
  display_name: string;
  donor_tier: string;
  donor_recurring: number;
  donor_since: number | null;
}

export function getTransparencyReports() {
  return req<{ reports: TransparencyReport[] }>('/features/transparency');
}

export function getSupportersWall() {
  return req<{ supporters: SupporterWallEntry[] }>('/features/supporters');
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

export function getInviteLink() {
  return req<{ link: string; username: string }>('/contacts/invite-link');
}

// ── Keys ──

export function getPreKeyBundle(userId: string) {
  return req(`/keys/bundle/${userId}`);
}

export function getWsTicket() {
  return req<{ ticket: string }>('/ws/ticket', { method: 'POST' });
}

// ── Profile ──

export function getMe() {
  return req<UserProfile>('/me');
}

export function updateSettings(settings: Record<string, unknown>) {
  return req('/me/settings', { method: 'PATCH', body: JSON.stringify(settings) });
}

// ── Key Transparency ──

export function getKeyAuditLog(userId: string) {
  return req<Array<{ event_type: string; new_key_fingerprint: string; old_key_fingerprint: string | null; created_at: string }>>(`/key-audit/${userId}`);
}

// ── Devices ──

export function getDevices() {
  return req<Device[]>('/devices');
}

export function deleteDevice(deviceId: string) {
  return req(`/devices/${deviceId}`, { method: 'DELETE' });
}

export function initiateDeviceVerification() {
  return req<{ code: string; expires_in: number }>('/devices/verify/initiate', { method: 'POST' });
}

export function confirmDeviceVerification(code: string) {
  return req<{ ok: boolean; verified: boolean; source_device_id: string }>('/devices/verify/confirm', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

// ── Key transfer ──

export function requestKeyTransfer(ephemeralPub: string) {
  return req<{ ok: boolean; requestId: string }>('/devices/key-transfer/request', {
    method: 'POST',
    body: JSON.stringify({ ephemeralPub }),
  });
}

export function getPendingKeyTransfers() {
  return req<{
    requests: { requestId: string; deviceId: string; ephemeralPub: string; createdAt: number }[];
  }>('/devices/key-transfer/pending');
}

export function uploadKeyBundle(requestId: string, encryptedBundle: string, ephemeralPub: string) {
  return req<{ ok: boolean }>('/devices/key-transfer/bundle', {
    method: 'POST',
    body: JSON.stringify({ requestId, encryptedBundle, ephemeralPub }),
  });
}

export function fetchKeyBundle(requestId: string) {
  return req<{ ready: boolean; encryptedBundle?: string; ephemeralPub?: string }>(
    `/devices/key-transfer/bundle?requestId=${encodeURIComponent(requestId)}`,
  );
}

// ── Recovery vault ──

export function uploadRecoveryVault(blob: string) {
  return req<{ ok: boolean }>('/recovery/vault', {
    method: 'POST',
    body: JSON.stringify({ blob }),
  });
}

export function getRecoveryVault() {
  return req<{ blob: string }>('/recovery/vault');
}

// ── Keys ──

export function getPreKeyCount() {
  return req<{ count: number }>('/keys/count');
}

export function uploadPreKeys(keys: { id: number; publicKey: string }[]) {
  return req('/keys/prekeys', { method: 'POST', body: JSON.stringify({ preKeys: keys }) });
}

export function rotateSignedPreKey(body: { id: number; publicKey: string; signature: string }) {
  return req('/keys/signed', { method: 'PUT', body: JSON.stringify(body) });
}

export function health() {
  return req('/health');
}

export function getStickers() {
  return req<{ stickers: { url: string; name: string; width: number; height: number }[] }>('/stickers');
}

export function getApiBase(): string {
  return BASE;
}

export async function uploadAvatar(file: File) {
  const headers: Record<string, string> = {};
  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  headers['Content-Type'] = file.type;
  const res = await fetch(`${BASE}/me/avatar`, { method: 'POST', headers, body: file });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export function deleteAvatar() {
  return req('/me/avatar', { method: 'DELETE' });
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
  encrypted_meta?: string;
  members: { user_id: string; username: string; display_name: string; avatar_url?: string; account_tier?: string }[];
  muted?: boolean;
  archived?: boolean;
  pinned?: boolean;
  chat_theme?: string | null;
  last_message_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  iv: string;
  tag?: string;
  ratchet_header: string;
  message_type: string;
  created_at: string;
  edited_at?: number;
  deleted_at?: number;
  expires_at?: number;
  reply_to?: string | null;
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

// ── Scheduled Messages ──

export function getScheduledMessages() {
  return req<{ id: string; conversation_id: string; scheduled_at: number; created_at: number }[]>('/features/scheduled');
}

export function createScheduledMessage(conversation_id: string, encrypted: string, scheduled_at: number) {
  return req<{ id: string; scheduled_at: number }>('/features/scheduled', {
    method: 'POST',
    body: JSON.stringify({ conversation_id, encrypted, scheduled_at }),
  });
}

export function deleteScheduledMessage(id: string) {
  return req<void>(`/features/scheduled/${id}`, { method: 'DELETE' });
}

// ── Chat Folders ──

export interface ChatFolder {
  id: string;
  name: string;
  icon: string;
  sort_order: number;
  conversation_ids: string[];
}

export function getChatFolders() {
  return req<ChatFolder[]>('/features/folders');
}

export function createChatFolder(name: string, icon = '📁') {
  return req<ChatFolder>('/features/folders', {
    method: 'POST',
    body: JSON.stringify({ name, icon }),
  });
}

export function deleteChatFolder(id: string) {
  return req<void>(`/features/folders/${id}`, { method: 'DELETE' });
}

export function addConvToFolder(folderId: string, conversationId: string) {
  return req<void>(`/features/folders/${folderId}/chats`, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId }),
  });
}

export function removeConvFromFolder(folderId: string, conversationId: string) {
  return req<void>(`/features/folders/${folderId}/chats/${conversationId}`, { method: 'DELETE' });
}

// ── Saved Contacts ──

export interface SavedContact {
  contact_id: string;
  nickname: string | null;
  username: string;
  display_name: string;
  avatar_url: string | null;
  saved_at: number;
}

export function getSavedContacts() {
  return req<SavedContact[]>('/features/contacts');
}

export function saveContact(contact_id: string, nickname?: string) {
  return req<void>('/features/contacts', {
    method: 'POST',
    body: JSON.stringify({ contact_id, nickname }),
  });
}

export function removeSavedContact(contactId: string) {
  return req<void>(`/features/contacts/${contactId}`, { method: 'DELETE' });
}

// ── Business / Organization ──

export interface Organization {
  id: string;
  name: string;
  logo_url: string | null;
  accent_color: string;
  role: string;
  created_at: number;
}

export interface OrgMember {
  user_id: string;
  role: string;
  joined_at: number;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export function getOrganizations() {
  return req<Organization[]>('/business/org');
}

export function createOrganization(name: string, accent_color?: string) {
  return req<{ org_id: string }>('/business/org', {
    method: 'POST',
    body: JSON.stringify({ name, accent_color }),
  });
}

export function getOrganization(orgId: string) {
  return req<Organization & { members: OrgMember[] }>(`/business/org/${orgId}`);
}

export function updateOrganization(orgId: string, data: { name?: string; accent_color?: string }) {
  return req<void>(`/business/org/${orgId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function addOrgMember(orgId: string, userId: string, role = 'member') {
  return req<void>(`/business/org/${orgId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, role }),
  });
}

export function removeOrgMember(orgId: string, userId: string) {
  return req<void>(`/business/org/${orgId}/members/${userId}`, { method: 'DELETE' });
}

export function wipeDevice(orgId: string, userId: string, deviceId: string) {
  return req<void>(`/business/org/${orgId}/wipe`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, device_id: deviceId }),
  });
}

export function getComplianceExport(orgId: string) {
  return req<Record<string, unknown>>(`/business/org/${orgId}/export`);
}

export function getRetentionPolicy(orgId: string) {
  return req<{ max_age_days: number; auto_delete: number }>(`/business/org/${orgId}/retention`);
}

export function setRetentionPolicy(orgId: string, maxAgeDays: number, autoDelete: boolean) {
  return req<void>(`/business/org/${orgId}/retention`, {
    method: 'PUT',
    body: JSON.stringify({ max_age_days: maxAgeDays, auto_delete: autoDelete ? 1 : 0 }),
  });
}

export function bulkAddOrgMembers(orgId: string, users: { username: string; role?: string }[]) {
  return req<{ added: number; total: number; results: { username: string; status: string }[] }>(`/business/org/${orgId}/members/bulk`, {
    method: 'POST',
    body: JSON.stringify({ users }),
  });
}

export function getSsoConfig(orgId: string) {
  return req<{ provider: string; issuer_url: string; client_id: string; redirect_uri: string; enabled: number }>(`/business/org/${orgId}/sso`);
}

export function setSsoConfig(orgId: string, config: { provider: string; issuer_url: string; client_id: string; client_secret: string; redirect_uri: string; enabled: boolean }) {
  return req<void>(`/business/org/${orgId}/sso`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export function deleteSsoConfig(orgId: string) {
  return req<void>(`/business/org/${orgId}/sso`, { method: 'DELETE' });
}

export function searchOrgDirectory(orgId: string, q = '') {
  return req<unknown[]>(`/business/org/${orgId}/directory?q=${encodeURIComponent(q)}`);
}

export function listApiKeys(orgId: string) {
  return req<unknown[]>(`/business/org/${orgId}/api-keys`);
}

export function createApiKey(orgId: string, name: string) {
  return req<{ id: string; name: string; key: string; key_prefix: string }>(`/business/org/${orgId}/api-keys`, {
    method: 'POST',
    body: JSON.stringify({ name, scopes: ['read', 'write'] }),
  });
}

export function revokeApiKey(orgId: string, keyId: string) {
  return req<{ ok: boolean }>(`/business/org/${orgId}/api-keys/${keyId}`, { method: 'DELETE' });
}

export function listWebhooks(orgId: string) {
  return req<unknown[]>(`/business/org/${orgId}/webhooks`);
}

export function createWebhook(orgId: string, url: string, events?: string[]) {
  return req<{ id: string; url: string; signing_secret: string }>(`/business/org/${orgId}/webhooks`, {
    method: 'POST',
    body: JSON.stringify({ url, events: events || ['message.sent', 'member.added', 'member.removed'] }),
  });
}

export function deleteWebhook(orgId: string, hookId: string) {
  return req<{ ok: boolean }>(`/business/org/${orgId}/webhooks/${hookId}`, { method: 'DELETE' });
}

// ── Link Previews ──

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
  site_name: string;
}

export function getLinkPreview(url: string) {
  return req<LinkPreview>(`/link-preview?url=${encodeURIComponent(url)}`);
}

// ── Group Moderation ──

export interface GroupMember {
  user_id: string;
  username: string;
  role: 'owner' | 'admin' | 'moderator' | 'member';
  muted_until: number | null;
  joined_at: number;
}

export function getGroupMembers(conversationId: string) {
  return req<{ members: GroupMember[] }>(`/groups/${conversationId}/members`);
}

export function promoteGroupMember(conversationId: string, userId: string, role: GroupMember['role']) {
  return req<{ ok: true }>(`/groups/${conversationId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, role }),
  });
}

export function kickGroupMember(conversationId: string, userId: string) {
  return req<{ ok: true }>(`/groups/${conversationId}/kick`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
}

export function muteGroupMember(conversationId: string, userId: string, until: number) {
  return req<{ ok: true; muted_until: number | null }>(`/groups/${conversationId}/mute`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, until }),
  });
}
