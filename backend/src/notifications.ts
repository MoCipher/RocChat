/**
 * RocChat — Server-side notification helpers.
 * Centralises cross-device push alerts that are not tied to a specific message.
 */

import type { Env } from './index.js';
import { logEvent } from './middleware.js';
import { sendSecurityAlert } from './push.js';

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
    logEvent('info', 'login_notification', { userId, newDeviceId, platform, ip: ip ?? 'unknown' });

    const title = 'New login detected';
    const body = `A new login from ${platform} (${deviceName}) was detected. If this was not you, revoke the session in Settings.`;

    await sendSecurityAlert(env, userId, title, body, newDeviceId);
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
