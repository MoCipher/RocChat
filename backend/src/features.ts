/**
 * RocChat Backend — Premium Features
 *
 * Scheduled messages, chat folders — available FREE for all users.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';

export async function handleFeatures(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // ── Scheduled Messages ──

  // POST /api/features/scheduled — Schedule a message
  if (path === '/api/features/scheduled' && request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    const convId = body.conversation_id as string;
    const encrypted = body.encrypted as string;
    const scheduledAt = body.scheduled_at as number;

    if (!convId || !encrypted || !scheduledAt) {
      return errorResponse('Missing required fields', 400);
    }
    if (scheduledAt < Date.now() / 1000) {
      return errorResponse('Scheduled time must be in the future', 400);
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO scheduled_messages (id, conversation_id, sender_id, encrypted, scheduled_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, convId, session.userId, encrypted, scheduledAt).run();

    return jsonResponse({ id, scheduled_at: scheduledAt });
  }

  // GET /api/features/scheduled — List scheduled messages
  if (path === '/api/features/scheduled' && request.method === 'GET') {
    const msgs = await env.DB.prepare(
      'SELECT id, conversation_id, scheduled_at, created_at FROM scheduled_messages WHERE sender_id = ? AND sent = 0 ORDER BY scheduled_at'
    ).bind(session.userId).all();
    return jsonResponse(msgs.results);
  }

  // DELETE /api/features/scheduled/:id — Cancel scheduled message
  if (path.startsWith('/api/features/scheduled/') && request.method === 'DELETE') {
    const id = path.split('/')[4];
    await env.DB.prepare(
      'DELETE FROM scheduled_messages WHERE id = ? AND sender_id = ? AND sent = 0'
    ).bind(id, session.userId).run();
    return jsonResponse({ ok: true });
  }

  // ── Chat Folders ──

  // GET /api/features/folders — List folders
  if (path === '/api/features/folders' && request.method === 'GET') {
    const folders = await env.DB.prepare(
      'SELECT f.id, f.name, f.icon, f.sort_order, GROUP_CONCAT(fi.conversation_id) as conversation_ids FROM chat_folders f LEFT JOIN chat_folder_items fi ON f.id = fi.folder_id WHERE f.user_id = ? GROUP BY f.id ORDER BY f.sort_order'
    ).bind(session.userId).all();
    return jsonResponse(folders.results.map((f: Record<string, unknown>) => ({
      ...f,
      conversation_ids: f.conversation_ids ? (f.conversation_ids as string).split(',') : [],
    })));
  }

  // POST /api/features/folders — Create folder
  if (path === '/api/features/folders' && request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    const name = body.name as string;
    if (!name || name.length < 1 || name.length > 50) {
      return errorResponse('Folder name must be 1-50 characters', 400);
    }
    const id = crypto.randomUUID();
    const icon = (body.icon as string) || '📁';
    const sortOrder = (body.sort_order as number) || 0;
    await env.DB.prepare(
      'INSERT INTO chat_folders (id, user_id, name, icon, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, session.userId, name, icon, sortOrder).run();
    return jsonResponse({ id, name, icon, sort_order: sortOrder });
  }

  // PUT /api/features/folders/:id — Update folder
  if (path.startsWith('/api/features/folders/') && !path.includes('/chats') && request.method === 'PUT') {
    const id = path.split('/')[4];
    const body = await request.json() as Record<string, unknown>;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name) {
      const name = body.name as string;
      if (name.length < 1 || name.length > 50) return errorResponse('Folder name must be 1-50 characters', 400);
      updates.push('name = ?'); values.push(name);
    }
    if (body.icon) { updates.push('icon = ?'); values.push(body.icon); }
    if (body.sort_order !== undefined) { updates.push('sort_order = ?'); values.push(body.sort_order); }

    if (updates.length > 0) {
      values.push(id, session.userId);
      await env.DB.prepare(`UPDATE chat_folders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...values).run();
    }
    return jsonResponse({ ok: true });
  }

  // DELETE /api/features/folders/:id — Delete folder
  if (path.startsWith('/api/features/folders/') && !path.includes('/chats') && request.method === 'DELETE') {
    const id = path.split('/')[4];
    await env.DB.prepare('DELETE FROM chat_folders WHERE id = ? AND user_id = ?')
      .bind(id, session.userId).run();
    return jsonResponse({ ok: true });
  }

  // POST /api/features/folders/:id/chats — Add conversation to folder
  if (path.match(/^\/api\/features\/folders\/[^/]+\/chats$/) && request.method === 'POST') {
    const folderId = path.split('/')[4];
    const body = await request.json() as { conversation_id: string };
    await env.DB.prepare(
      'INSERT OR IGNORE INTO chat_folder_items (folder_id, conversation_id) VALUES (?, ?)'
    ).bind(folderId, body.conversation_id).run();
    return jsonResponse({ ok: true });
  }

  // DELETE /api/features/folders/:id/chats/:convId — Remove conversation from folder
  if (path.match(/^\/api\/features\/folders\/[^/]+\/chats\/[^/]+$/) && request.method === 'DELETE') {
    const parts = path.split('/');
    const folderId = parts[4];
    const convId = parts[6];
    await env.DB.prepare(
      'DELETE FROM chat_folder_items WHERE folder_id = ? AND conversation_id = ?'
    ).bind(folderId, convId).run();
    return jsonResponse({ ok: true });
  }

  // ── Contacts (save with nickname) ──

  // GET /api/features/contacts — List saved contacts
  if (path === '/api/features/contacts' && request.method === 'GET') {
    const contacts = await env.DB.prepare(`
      SELECT c.contact_user_id as contact_id, c.nickname, c.created_at as saved_at,
             u.username, u.display_name, u.avatar_url
      FROM contacts c
      JOIN users u ON u.id = c.contact_user_id
      WHERE c.user_id = ?
      ORDER BY COALESCE(c.nickname, u.display_name, u.username)
    `).bind(session.userId).all();
    return jsonResponse(contacts.results);
  }

  // POST /api/features/contacts — Save a contact
  if (path === '/api/features/contacts' && request.method === 'POST') {
    const body = await request.json() as { contact_id: string; nickname?: string };
    if (!body.contact_id) return errorResponse('Missing contact_id', 400);

    // Verify user exists
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(body.contact_id).first();
    if (!user) return errorResponse('User not found', 404);

    if (body.nickname && body.nickname.length > 64) {
      return errorResponse('Nickname must be under 64 characters', 400);
    }

    await env.DB.prepare(
      'INSERT OR REPLACE INTO contacts (user_id, contact_user_id, nickname) VALUES (?, ?, ?)'
    ).bind(session.userId, body.contact_id, body.nickname || null).run();
    return jsonResponse({ ok: true });
  }

  // DELETE /api/features/contacts/:id — Remove a saved contact
  if (path.startsWith('/api/features/contacts/') && request.method === 'DELETE') {
    const contactId = path.split('/')[4];
    await env.DB.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?')
      .bind(session.userId, contactId).run();
    return jsonResponse({ ok: true });
  }

  // ── Chat Import (WhatsApp/Telegram/Signal) ──

  // POST /api/features/import — Import chat history from exported archive
  if (path === '/api/features/import' && request.method === 'POST') {
    const body = await request.json() as {
      source: string;
      conversation_id: string;
      messages: Array<{
        sender_name: string;
        body: string;
        timestamp: string;
        media_blob_id?: string;
      }>;
    };

    if (!body.source || !body.conversation_id || !Array.isArray(body.messages)) {
      return errorResponse('Missing source, conversation_id, or messages array', 400);
    }

    const validSources = ['whatsapp', 'telegram', 'signal'];
    if (!validSources.includes(body.source)) {
      return errorResponse('Invalid source. Must be whatsapp, telegram, or signal', 400);
    }

    if (body.messages.length > 10000) {
      return errorResponse('Maximum 10,000 messages per import batch', 400);
    }

    // Verify membership
    const membership = await env.DB.prepare(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(body.conversation_id, session.userId).first();
    if (!membership) return errorResponse('Not a member of this conversation', 403);

    // Insert imported messages (already re-encrypted client-side)
    const imported: string[] = [];
    for (const msg of body.messages) {
      const id = crypto.randomUUID();
      const ts = msg.timestamp ? Math.floor(new Date(msg.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, sender_id, encrypted, message_type, server_timestamp, imported_from)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, body.conversation_id, session.userId, msg.body, 'imported', ts, body.source).run();
      imported.push(id);
    }

    return jsonResponse({ imported: imported.length, source: body.source });
  }

  // ── Donor Badges ──

  // POST /api/features/donor — Set donor tier (after payment verification)
  if (path === '/api/features/donor' && request.method === 'POST') {
    const body = await request.json() as { tier: string; show_badge?: boolean };
    const validTiers = ['coffee', 'feather', 'wing', 'mountain', 'patron'];
    if (!body.tier || !validTiers.includes(body.tier)) {
      return errorResponse('Invalid tier. Must be: coffee, feather, wing, mountain, patron', 400);
    }
    await env.DB.prepare(
      'UPDATE users SET donor_tier = ? WHERE id = ?'
    ).bind(body.tier, session.userId).run();
    return jsonResponse({ tier: body.tier });
  }

  // GET /api/features/donor — Get current donor tier
  if (path === '/api/features/donor' && request.method === 'GET') {
    const user = await env.DB.prepare(
      'SELECT donor_tier, donor_recurring, donor_since FROM users WHERE id = ?'
    ).bind(session.userId).first() as { donor_tier: string | null; donor_recurring?: number; donor_since?: number | null } | null;
    return jsonResponse({
      tier: user?.donor_tier || null,
      recurring: user?.donor_recurring ? true : false,
      donor_since: user?.donor_since || null,
    });
  }

  // DELETE /api/features/donor — Remove donor badge
  if (path === '/api/features/donor' && request.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE users SET donor_tier = NULL WHERE id = ?'
    ).bind(session.userId).run();
    return jsonResponse({ ok: true });
  }

  // ── Warrant Canary ──

  // GET /api/features/canary — Public warrant canary
  if (path === '/api/features/canary' && request.method === 'GET') {
    return jsonResponse({
      status: 'clear',
      last_updated: '2026-04-01T00:00:00Z',
      statement: 'As of the date above, RocChat has NOT received any National Security Letters, FISA court orders, or gag orders. We have NOT been required to provide user data to any government agency. We have NOT placed any backdoors in our software. This canary is updated quarterly.',
      next_update: '2026-07-01T00:00:00Z',
      signed_by: 'RocChat Team',
    });
  }

  // ── Quiet Hours / DND Exceptions ──

  // GET /api/features/quiet-hours — Get quiet hours config
  if (path === '/api/features/quiet-hours' && request.method === 'GET') {
    const config = await env.DB.prepare(
      'SELECT quiet_start, quiet_end, dnd_exceptions FROM users WHERE id = ?'
    ).bind(session.userId).first() as { quiet_start: string | null; quiet_end: string | null; dnd_exceptions: string | null } | null;
    return jsonResponse({
      quiet_start: config?.quiet_start || null,
      quiet_end: config?.quiet_end || null,
      dnd_exceptions: config?.dnd_exceptions ? JSON.parse(config.dnd_exceptions) : [],
    });
  }

  // PUT /api/features/quiet-hours — Set quiet hours (HH:MM format)
  if (path === '/api/features/quiet-hours' && request.method === 'PUT') {
    const body = await request.json() as { quiet_start?: string; quiet_end?: string; dnd_exceptions?: string[] };
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

    if (body.quiet_start !== undefined && body.quiet_start !== null && !timeRegex.test(body.quiet_start)) {
      return errorResponse('quiet_start must be in HH:MM format', 400);
    }
    if (body.quiet_end !== undefined && body.quiet_end !== null && !timeRegex.test(body.quiet_end)) {
      return errorResponse('quiet_end must be in HH:MM format', 400);
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.quiet_start !== undefined) { updates.push('quiet_start = ?'); values.push(body.quiet_start); }
    if (body.quiet_end !== undefined) { updates.push('quiet_end = ?'); values.push(body.quiet_end); }
    if (body.dnd_exceptions !== undefined) {
      if (!Array.isArray(body.dnd_exceptions)) return errorResponse('dnd_exceptions must be an array', 400);
      updates.push('dnd_exceptions = ?');
      values.push(JSON.stringify(body.dnd_exceptions));
    }

    if (updates.length > 0) {
      values.push(session.userId);
      await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...values).run();
    }
    return jsonResponse({ ok: true });
  }

  // DELETE /api/features/quiet-hours — Clear quiet hours
  if (path === '/api/features/quiet-hours' && request.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE users SET quiet_start = NULL, quiet_end = NULL WHERE id = ?'
    ).bind(session.userId).run();
    return jsonResponse({ ok: true });
  }

  return errorResponse('Not found', 404);
}
