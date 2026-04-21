/**
 * RocChat — Server-side notification helpers.
 * Centralises cross-device push alerts that are not tied to a specific message.
 */

import type { Env } from './index.js';
import { logEvent } from './middleware.js';

/**
 * Send a push alert to every device belonging to `userId` EXCEPT `newDeviceId`.
 * Used to warn other sessions that a new login occurred.
 */
export async function sendLoginNotification(
  env: Env,
  userId: string,
  newDeviceId: string,
  platform: string,
  deviceName: string,
  ip?: string,
): Promise<void> {
  try {
    const devices = await env.DB.prepare(
      `SELECT id, push_token, push_platform
       FROM devices
       WHERE user_id = ? AND id != ? AND push_token IS NOT NULL`,
    ).bind(userId, newDeviceId).all<{ id: string; push_token: string; push_platform: string }>();

    if (!devices.results?.length) return;

    logEvent('info', 'login_notification', { userId, newDeviceId, platform, ip: ip ?? 'unknown', notifyCount: devices.results.length });

    const title = 'New login detected';
    const body = `A new login from ${platform} (${deviceName}) was detected. If this was not you, revoke the session in Settings.`;

    await Promise.allSettled(
      devices.results.map(async (device) => {
        try {
          const payload = JSON.stringify({ title, body, type: 'security_alert', data: { kind: 'new_login', platform, device_name: deviceName } });
          // Use the same VAPID sender used elsewhere; re-use env-level push infra.
          // We call the /api/push/send internal logic rather than re-implementing web-push here.
          const kvKey = `push_direct:${device.id}:${Date.now()}`;
          await env.KV.put(kvKey, payload, { expirationTtl: 300 });
          // Actual delivery is handled by the push worker polling this KV key,
          // OR we can write directly to the push_queue:
          await env.KV.put(`push_queue:${device.push_platform}:${Date.now()}_${device.id}`, JSON.stringify({
            token: device.push_token,
            platform: device.push_platform,
            title,
            body,
            data: { kind: 'new_login', platform, device_name: deviceName },
          }), { expirationTtl: 3600 });
        } catch { /* per-device failure is non-fatal */ }
      }),
    );
  } catch (err) {
    logEvent('error', 'login_notification_failed', { userId, err: String(err) });
  }
}

/**
 * Signal the user's web session(s) to replenish one-time pre-keys.
 * Writes a short-lived KV entry that the client's pre-key check polls on reconnect.
 */
export async function signalPreKeyRefill(env: Env, userId: string, remaining: number): Promise<void> {
  try {
    await env.KV.put(`refill_signal:${userId}`, String(remaining), { expirationTtl: 3600 });
  } catch { /* non-critical */ }
}
