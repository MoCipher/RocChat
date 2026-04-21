/**
 * RocChat Backend — Encrypted Media (R2)
 *
 * Upload/download encrypted media blobs. All media is encrypted client-side
 * before upload; server never sees plaintext.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

const ALLOWED_TYPES = new Set([
  'application/octet-stream', // Encrypted blobs
  'application/x-encrypted',
]);

const ALLOWED_ENCRYPTED_MIME = /^(image\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/(pdf|zip|json|octet-stream)|text\/plain)$/i;

export async function handleMedia(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // POST /api/media/upload
  if (path === '/api/media/upload' && request.method === 'POST') {
    return uploadMedia(request, env, session);
  }

  // GET /api/media/:mediaId?cid=conversationId
  if (path.startsWith('/api/media/') && request.method === 'GET') {
    const mediaId = path.split('/api/media/')[1];
    if (!mediaId || mediaId.includes('/') || mediaId === 'upload') {
      return errorResponse('Invalid media ID', 400);
    }
    const conversationId = url.searchParams.get('cid') || '';
    return downloadMedia(env, session, mediaId, conversationId);
  }

  // DELETE /api/media/:mediaId?cid=conversationId
  if (path.startsWith('/api/media/') && request.method === 'DELETE') {
    const mediaId = path.split('/api/media/')[1];
    if (!mediaId || mediaId.includes('/')) return errorResponse('Invalid media ID', 400);
    const conversationId = url.searchParams.get('cid') || '';
    return deleteMedia(env, session, mediaId, conversationId);
  }

  return errorResponse('Not found', 404);
}

async function uploadMedia(request: Request, env: Env, session: Session): Promise<Response> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
    return errorResponse('File too large (max 100MB)', 413);
  }

  const contentType = request.headers.get('content-type') || 'application/octet-stream';

  // Only accept encrypted blobs
  if (!ALLOWED_TYPES.has(contentType)) {
    return errorResponse('Only encrypted blobs are accepted', 415);
  }

  // Metadata from headers (client sets these)
  const conversationId = request.headers.get('x-conversation-id');
  const encryptedFileName = request.headers.get('x-encrypted-filename') || '';
  const encryptedMimeType = request.headers.get('x-encrypted-mimetype') || '';

  // Reject NUL bytes or CR/LF in opaque metadata headers (header-splitting / R2
  // customMetadata corruption defense). These headers are ciphertext but must
  // still be safe ASCII after base64.
  const UNSAFE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
  if (UNSAFE_RE.test(encryptedFileName) || UNSAFE_RE.test(encryptedMimeType)) {
    return errorResponse('Invalid metadata headers', 400);
  }
  if (encryptedFileName.length > 4096 || encryptedMimeType.length > 512) {
    return errorResponse('Metadata headers too long', 400);
  }
  if (!encryptedFileName.trim()) {
    return errorResponse('Missing encrypted filename metadata', 400);
  }
  if (!encryptedMimeType.trim() || !ALLOWED_ENCRYPTED_MIME.test(encryptedMimeType)) {
    return errorResponse('Unsupported encrypted mime metadata', 415);
  }

  if (!conversationId) {
    return errorResponse('Missing x-conversation-id header', 400);
  }

  // Verify user is a member of the conversation
  const member = await env.DB.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
  )
    .bind(conversationId, session.userId)
    .first();

  if (!member) {
    return errorResponse('Not a member of this conversation', 403);
  }

  const mediaId = crypto.randomUUID();
  const r2Key = `${conversationId}/${mediaId}`;

  // Per-user media quota: track upload count in KV (500 files max)
  const quotaKey = `media_count:${session.userId}`;
  const countStr = await env.KV.get(quotaKey);
  const mediaCount = countStr ? parseInt(countStr, 10) : 0;
  if (mediaCount >= 500) {
    return errorResponse('Media storage quota exceeded', 413);
  }

  const body = request.body;
  if (!body) return errorResponse('Empty body', 400);

  await env.MEDIA.put(r2Key, body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      uploaderId: session.userId,
      conversationId,
      encryptedFileName,
      encryptedMimeType,
      uploadedAt: new Date().toISOString(),
    },
  });

  await env.KV.put(quotaKey, String(mediaCount + 1));

  return jsonResponse({ mediaId, key: r2Key }, 201);
}

async function downloadMedia(env: Env, session: Session, mediaId: string, conversationId: string): Promise<Response> {
  // Direct R2 key lookup: conversationId/mediaId
  let r2Key: string | null = null;

  if (conversationId) {
    // Direct lookup — O(1)
    r2Key = `${conversationId}/${mediaId}`;
    const exists = await env.MEDIA.head(r2Key);
    if (!exists) r2Key = null;
  } else {
    // Fallback: prefix scan with the mediaId (for backward compat)
    const listed = await env.MEDIA.list({ limit: 100 });
    for (const obj of listed.objects) {
      if (obj.key.endsWith(mediaId)) {
        r2Key = obj.key;
        break;
      }
    }
  }

  if (!r2Key) return errorResponse('Media not found', 404);

  // Verify membership
  const convId = r2Key.split('/')[0];
  const member = await env.DB.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
  )
    .bind(convId, session.userId)
    .first();
  if (!member) return errorResponse('Access denied', 403);

  const object = await env.MEDIA.get(r2Key);
  if (!object) return errorResponse('Media not found', 404);

  return new Response(object.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
      'x-encrypted-filename': object.customMetadata?.encryptedFileName || '',
      'x-encrypted-mimetype': object.customMetadata?.encryptedMimeType || '',
    },
  });
}

async function deleteMedia(env: Env, session: Session, mediaId: string, conversationId: string): Promise<Response> {
  // Direct R2 key lookup
  let r2Key: string | null = null;

  if (conversationId) {
    r2Key = `${conversationId}/${mediaId}`;
    const exists = await env.MEDIA.head(r2Key);
    if (!exists) r2Key = null;
  } else {
    const listed = await env.MEDIA.list({ limit: 100 });
    for (const obj of listed.objects) {
      if (obj.key.endsWith(mediaId)) {
        r2Key = obj.key;
        break;
      }
    }
  }

  if (!r2Key) return errorResponse('Media not found', 404);

  // Only the uploader can delete
  const object = await env.MEDIA.head(r2Key);
  if (!object) return errorResponse('Media not found', 404);

  if (object.customMetadata?.uploaderId !== session.userId) {
    return errorResponse('Only the uploader can delete this media', 403);
  }

  await env.MEDIA.delete(r2Key);
  return jsonResponse({ ok: true });
}
