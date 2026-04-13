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
 */
export async function sendPushNotification(
  env: Env,
  recipientUserId: string,
  senderName: string,
): Promise<void> {
  const devices = await env.DB.prepare(
    'SELECT push_token, push_platform FROM devices WHERE user_id = ? AND push_token IS NOT NULL',
  )
    .bind(recipientUserId)
    .all<{ push_token: string; push_platform: string }>();

  if (!devices.results?.length) return;

  const promises = devices.results.map(async (device) => {
    try {
      if (device.push_platform === 'apns') {
        await sendAPNs(env, device.push_token, senderName);
      } else if (device.push_platform === 'ntfy') {
        await sendNtfy(device.push_token, senderName);
      } else if (device.push_platform === 'web') {
        await sendWebPush(env, device.push_token, senderName);
      }
    } catch (err) {
      console.error(`Push failed for ${device.push_platform}:`, err);
    }
  });

  await Promise.allSettled(promises);
}

async function sendAPNs(
  env: Env,
  deviceToken: string,
  senderName: string,
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
        title: 'RocChat',
        body: `New message from ${senderName}`,
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
 * Send push via ntfy.sh — free, open-source, no account required.
 * The topic is a unique per-user string registered by the Android app.
 */
async function sendNtfy(
  topic: string,
  senderName: string,
): Promise<void> {
  const resp = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      'Title': 'RocChat',
      'Priority': 'high',
      'Tags': 'locked_with_key',
    },
    body: `New message from ${senderName}`,
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('ntfy error:', resp.status, err);
  }
}

async function sendWebPush(
  env: Env,
  subscription: string,
  senderName: string,
): Promise<void> {
  // Web Push uses the Push API with VAPID
  // For now, log — full web push requires VAPID key generation
  console.log('Web push not yet implemented for subscription:', subscription.substring(0, 20));
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
