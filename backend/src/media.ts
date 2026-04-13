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
