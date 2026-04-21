import type { Env } from './index.js';

const POW_CHALLENGE_TTL_SECONDS = 5 * 60;

export type PowChallenge = {
  token: string;
  challenge: string;
  difficulty: number;
  expires_in: number;
};

type StoredChallenge = {
  challenge: string;
  difficulty: number;
  expires_at: number;
  ip: string;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

function leadingZeroBitsFromHex(hex: string): number {
  let bits = 0;
  for (const ch of hex) {
    if (ch === '0') {
      bits += 4;
      continue;
    }
    const nibble = parseInt(ch, 16);
    if (Number.isNaN(nibble)) break;
    if ((nibble & 0b1000) === 0) bits += 1; else return bits;
    if ((nibble & 0b0100) === 0) bits += 1; else return bits;
    if ((nibble & 0b0010) === 0) bits += 1; else return bits;
    if ((nibble & 0b0001) === 0) bits += 1; else return bits;
  }
  return bits;
}

/** Read PoW difficulty from KV (runtime-updatable), fall back to env, clamp to sane range. */
export async function getPowDifficulty(env: Env): Promise<number> {
  try {
    const kv = await env.KV.get('pow:difficulty');
    if (kv) {
      const n = parseInt(kv, 10);
      if (!isNaN(n)) return Math.min(Math.max(n, 12), 28);
    }
  } catch { /* KV unavailable */ }
  return Math.min(Math.max(parseInt(env.POW_DIFFICULTY || '18', 10) || 18, 12), 28);
}

export async function createPowChallenge(env: Env, difficulty: number, ip: string): Promise<PowChallenge> {
  const token = crypto.randomUUID();
  const challenge = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const expiresAt = Math.floor(Date.now() / 1000) + POW_CHALLENGE_TTL_SECONDS;
  const payload: StoredChallenge = {
    challenge,
    difficulty,
    expires_at: expiresAt,
    ip,
  };
  await env.KV.put(`pow:challenge:${token}`, JSON.stringify(payload), { expirationTtl: POW_CHALLENGE_TTL_SECONDS });
  return {
    token,
    challenge,
    difficulty,
    expires_in: POW_CHALLENGE_TTL_SECONDS,
  };
}

export async function verifyPowSolution(
  env: Env,
  token: string,
  nonce: string,
  ip: string,
): Promise<boolean> {
  const raw = await env.KV.get(`pow:challenge:${token}`);
  if (!raw) return false;

  const payload = JSON.parse(raw) as StoredChallenge;
  const now = Math.floor(Date.now() / 1000);
  if (payload.expires_at < now) {
    await env.KV.delete(`pow:challenge:${token}`);
    return false;
  }
  if (payload.ip !== ip) return false;

  const digest = await sha256Hex(`${payload.challenge}:${nonce}`);
  const ok = leadingZeroBitsFromHex(digest) >= payload.difficulty;
  if (ok) {
    await env.KV.delete(`pow:challenge:${token}`);
  }
  return ok;
}
