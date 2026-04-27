/**
 * RocChat Backend — Push Notifications
 *
 * Manages push token registration and sending push notifications
 * via APNs (iOS) and FCM (Android).
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';

export async function handlePush(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // POST /api/push/register — register or update a push token
  if (path === '/api/push/register' && request.method === 'POST') {
    return registerPushToken(request, env, session);
  }

  // DELETE /api/push/token — remove push token for current device
  if (path === '/api/push/token' && request.method === 'DELETE') {
    return removePushToken(env, session);
  }

  return errorResponse('Not found', 404);
}

async function registerPushToken(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const body = await request.json() as {
    token?: string;
    platform?: 'apns' | 'ntfy' | 'web';
  };

  if (!body.token || !body.platform) {
    return errorResponse('Missing token or platform', 400);
  }

  if (!['apns', 'ntfy', 'web'].includes(body.platform)) {
    return errorResponse('Invalid platform', 400);
  }

  // Update the device with the push token
  await env.DB.prepare(
    'UPDATE devices SET push_token = ?, push_platform = ? WHERE id = ? AND user_id = ?',
  )
    .bind(body.token, body.platform, session.deviceId, session.userId)
    .run();

  return jsonResponse({ ok: true });
}

async function removePushToken(env: Env, session: Session): Promise<Response> {
  await env.DB.prepare(
    'UPDATE devices SET push_token = NULL, push_platform = NULL WHERE id = ? AND user_id = ?',
  )
    .bind(session.deviceId, session.userId)
    .run();

  return jsonResponse({ ok: true });
}

/**
 * Send push notification to all devices of a user (called from message handler).
 * This is a best-effort delivery — failures are logged but don't block message storage.
 *
 * E2E privacy: push body is intentionally generic ("New message") so that
 * no plaintext content or sender identity leaks to APNs / ntfy / Web Push
 * infrastructure. Clients that want rich notifications should use a
 * Notification Service Extension with local ratchet state.
 */
export async function sendPushNotification(
  env: Env,
  recipientUserId: string,
  _senderName?: string,
  senderUserId?: string,
  msgPriority?: string,
): Promise<void> {
  // Urgent messages bypass quiet hours
  if (msgPriority !== 'urgent') {
  // Check quiet hours
  const userConfig = await env.DB.prepare(
    'SELECT quiet_start, quiet_end, dnd_exceptions FROM users WHERE id = ?'
  ).bind(recipientUserId).first<{ quiet_start: string | null; quiet_end: string | null; dnd_exceptions: string | null }>();

  if (userConfig?.quiet_start && userConfig?.quiet_end) {
    // Check if sender is in DND exceptions
    const exceptions: string[] = userConfig.dnd_exceptions ? JSON.parse(userConfig.dnd_exceptions) : [];
    const isException = senderUserId ? exceptions.includes(senderUserId) : false;

    if (!isException) {
      // Check if current time is within quiet hours (UTC)
      const now = new Date();
      const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      const [startH, startM] = userConfig.quiet_start.split(':').map(Number);
      const [endH, endM] = userConfig.quiet_end.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      let inQuietHours: boolean;
      if (startMinutes <= endMinutes) {
        inQuietHours = currentMinutes >= startMinutes && currentMinutes < endMinutes;
      } else {
        // Wraps midnight (e.g., 22:00 to 07:00)
        inQuietHours = currentMinutes >= startMinutes || currentMinutes < endMinutes;
      }

      if (inQuietHours) return; // Skip notification during quiet hours
    }
  }
  } // end urgent bypass

  const devices = await env.DB.prepare(
    'SELECT push_token, push_platform FROM devices WHERE user_id = ? AND push_token IS NOT NULL',
  )
    .bind(recipientUserId)
    .all<{ push_token: string; push_platform: string }>();

  if (!devices.results?.length) return;

  const title = 'RocChat';
  const body = 'New message';
  const promises = devices.results.map(async (device) => {
    try {
      await dispatchPush(env, device, title, body);
    } catch (err) {
      console.error(`Push failed for ${device.push_platform}:`, err);
    }
  });

  await Promise.allSettled(promises);
}

/**
 * Send a high-priority security alert (bypasses quiet hours) to all devices
 * of `userId` except `excludeDeviceId`.
 */
export async function sendSecurityAlert(
  env: Env,
  userId: string,
  title: string,
  body: string,
  excludeDeviceId?: string,
): Promise<void> {
  const query = excludeDeviceId
    ? 'SELECT push_token, push_platform FROM devices WHERE user_id = ? AND id != ? AND push_token IS NOT NULL'
    : 'SELECT push_token, push_platform FROM devices WHERE user_id = ? AND push_token IS NOT NULL';
  const stmt = excludeDeviceId
    ? env.DB.prepare(query).bind(userId, excludeDeviceId)
    : env.DB.prepare(query).bind(userId);
  const devices = await stmt.all<{ push_token: string; push_platform: string }>();
  if (!devices.results?.length) return;
  await Promise.allSettled(
    devices.results.map((device) => dispatchPush(env, device, title, body).catch(() => {})),
  );
}

async function dispatchPush(
  env: Env,
  device: { push_token: string; push_platform: string },
  title: string,
  body: string,
): Promise<void> {
  if (device.push_platform === 'apns') {
    await sendAPNs(env, device.push_token, title, body);
  } else if (device.push_platform === 'ntfy') {
    await sendNtfy(device.push_token, title, body);
  } else if (device.push_platform === 'web') {
    await sendWebPush(env, device.push_token, title, body);
  }
}

async function sendAPNs(
  env: Env,
  deviceToken: string,
  title: string,
  body: string,
): Promise<void> {
  const apnsKey = env.APNS_KEY;
  const apnsKeyId = env.APNS_KEY_ID;
  const apnsTeamId = env.APNS_TEAM_ID;
  const apnsTopic = env.APNS_TOPIC;

  if (!apnsKey || !apnsKeyId || !apnsTeamId) return;

  // Generate JWT for APNs auth (ES256)
  const jwt = await generateAPNsJWT(apnsKey, apnsKeyId, apnsTeamId);

  const payload = {
    aps: {
      alert: {
        title,
        body,
      },
      badge: 1,
      sound: 'default',
      'mutable-content': 1,
    },
  };

  const resp = await fetch(
    `https://api.push.apple.com/3/device/${deviceToken}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `bearer ${jwt}`,
        'apns-topic': apnsTopic || 'com.rocchat.ios',
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    console.error('APNs error:', resp.status, err);
  }
}

/**
 * Send push via ntfy — self-hostable, open-source, no corporate dependency.
 * Default: self-hosted ntfy instance. Configure NTFY_URL env var.
 */
async function sendNtfy(
  topic: string,
  title: string,
  body: string,
  ntfyUrl?: string,
): Promise<void> {
  const base = ntfyUrl || 'https://ntfy.roc.family';
  const resp = await fetch(`${base}/${topic}`, {
    method: 'POST',
    headers: {
      'Title': title,
      'Priority': 'high',
      'Tags': 'locked_with_key',
    },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('ntfy error:', resp.status, err);
  }
}

async function sendWebPush(
  env: Env,
  subscriptionJson: string,
  title: string,
  notifBody: string,
): Promise<void> {
  // Web Push via VAPID (RFC 8292)
  // subscription is stored as JSON: { endpoint, keys: { p256dh, auth } }
  let sub: { endpoint: string; keys: { p256dh: string; auth: string } };
  try {
    sub = JSON.parse(subscriptionJson);
  } catch {
    console.error('Invalid web push subscription JSON');
    return;
  }

  const vapidPublicKey = await env.KV.get('vapid_public_key');
  const vapidPrivateKey = await env.KV.get('vapid_private_key');
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn('VAPID keys not configured — skipping web push');
    return;
  }

  const payload = JSON.stringify({
    title,
    body: notifBody,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'rocchat-message',
  });

  // Build VAPID JWT
  const audience = new URL(sub.endpoint).origin;
  const vapidJwt = await buildVapidJwt(vapidPrivateKey, vapidPublicKey, audience);

  // Encrypt payload using Web Push encryption (simplified: aes128gcm)
  // For Workers, use raw fetch with encrypted payload
  const authBytes = base64UrlDecode(sub.keys.auth);
  const p256dhBytes = base64UrlDecode(sub.keys.p256dh);

  // Generate local ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const localPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey) as ArrayBuffer);

  // Derive shared secret
  const userPublicKey = await crypto.subtle.importKey('raw', p256dhBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: userPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, localKeyPair.privateKey, 256));

  // HKDF for content encryption key
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const authInfo = encoder.encode('Content-Encoding: auth\0');
  const ikmMaterial = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const prk = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authBytes, info: authInfo }, ikmMaterial, 256));

  const cekInfo = buildInfo('aesgcm', p256dhBytes, localPublicRaw);
  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  const cekBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, prkKey, 128));
  const nonceInfo = buildInfo('nonce', p256dhBytes, localPublicRaw);
  const nonceBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prkKey, 96));

  const cek = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  const padded = new Uint8Array([0, 0, ...encoder.encode(payload)]); // 2-byte padding
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBits }, cek, padded));

  // Build body: salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const body = new Uint8Array(16 + 4 + 1 + localPublicRaw.length + encrypted.length);
  body.set(salt, 0);
  body.set(rs, 16);
  body[20] = localPublicRaw.length;
  body.set(localPublicRaw, 21);
  body.set(encrypted, 21 + localPublicRaw.length);

  const resp = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': `vapid t=${vapidJwt}, k=${vapidPublicKey}`,
    },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Web push error:', resp.status, err);
  }
}

function base64UrlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

function buildInfo(type: string, clientPublic: Uint8Array, serverPublic: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const label = enc.encode(`Content-Encoding: ${type}\0P-256\0`);
  const info = new Uint8Array(label.length + 2 + clientPublic.length + 2 + serverPublic.length);
  let offset = 0;
  info.set(label, offset); offset += label.length;
  new DataView(info.buffer).setUint16(offset, clientPublic.length); offset += 2;
  info.set(clientPublic, offset); offset += clientPublic.length;
  new DataView(info.buffer).setUint16(offset, serverPublic.length); offset += 2;
  info.set(serverPublic, offset);
  return info;
}

async function buildVapidJwt(privateKeyB64: string, publicKeyB64: string, audience: string): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud: audience, exp: Math.floor(Date.now() / 1000) + 86400, sub: 'mailto:push@rocchat.app' };
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const input = `${enc(header)}.${enc(claims)}`;
  const keyData = base64UrlDecode(privateKeyB64);
  const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)));
  const sigB64 = btoa(String.fromCharCode(...sig)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${input}.${sigB64}`;
}

async function generateAPNsJWT(
  privateKeyPem: string,
  keyId: string,
  teamId: string,
): Promise<string> {
  const header = { alg: 'ES256', kid: keyId };
  const claims = {
    iss: teamId,
    iat: Math.floor(Date.now() / 1000),
  };

  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const claimsB64 = btoa(JSON.stringify(claims)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${headerB64}.${claimsB64}`;

  // Import the PKCS#8 private key
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${signingInput}.${sigB64}`;
}
