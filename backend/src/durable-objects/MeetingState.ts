type ParticipantRole = 'host' | 'moderator' | 'participant' | 'viewer';
type MeetingStatus = 'scheduled' | 'live' | 'ended';

interface ParticipantState {
  userId: string;
  role: ParticipantRole;
  joinedAt: number;
  raisedHand: boolean;
  inLobby: boolean;
}

interface MeetingStateData {
  meetingId: string;
  status: MeetingStatus;
  mediaMode: 'mesh' | 'sfu';
  locked: boolean;
  hostUserId: string;
  participants: Record<string, ParticipantState>;
}

export class MeetingState {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.endsWith('/state')) {
      const current = await this.getState();
      return json({ ok: true, meeting: current });
    }
    if (request.method === 'POST' && url.pathname.endsWith('/event')) {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return json({ ok: false, error: 'Invalid body' }, 400);
      const updated = await this.applyEvent(body);
      return json({ ok: true, meeting: updated });
    }
    return json({ ok: false, error: 'Not found' }, 404);
  }

  private async getState(): Promise<MeetingStateData> {
    const existing = await this.state.storage.get<MeetingStateData>('meeting');
    if (existing) return existing;
    const fallback: MeetingStateData = {
      meetingId: '',
      status: 'scheduled',
      mediaMode: 'sfu',
      locked: false,
      hostUserId: '',
      participants: {},
    };
    await this.state.storage.put('meeting', fallback);
    return fallback;
  }

  private async applyEvent(ev: Record<string, unknown>): Promise<MeetingStateData> {
    const curr = await this.getState();
    const action = String(ev.action || '');
    const actorUserId = String(ev.actorUserId || '');
    const targetUserId = ev.targetUserId ? String(ev.targetUserId) : '';
    const role = (ev.role ? String(ev.role) : '') as ParticipantRole;
    const mediaMode = ev.mediaMode ? String(ev.mediaMode) : '';
    const meetingId = String(ev.meetingId || curr.meetingId || '');
    const next: MeetingStateData = {
      ...curr,
      meetingId,
      mediaMode: mediaMode === 'mesh' ? 'mesh' : curr.mediaMode,
    };
    const participants = { ...next.participants };
    const ensureActor = () => {
      if (!actorUserId) return;
      if (!participants[actorUserId]) {
        participants[actorUserId] = {
          userId: actorUserId,
          role: role || (actorUserId === next.hostUserId ? 'host' : 'participant'),
          joinedAt: Date.now(),
          raisedHand: false,
          inLobby: false,
        };
      }
    };
    ensureActor();
    switch (action) {
      case 'join':
        if (actorUserId) {
          participants[actorUserId] = {
            userId: actorUserId,
            role: role || participants[actorUserId]?.role || (actorUserId === next.hostUserId ? 'host' : 'participant'),
            joinedAt: Date.now(),
            raisedHand: false,
            inLobby: false,
          };
          if (!next.hostUserId) next.hostUserId = actorUserId;
          next.status = 'live';
        }
        break;
      case 'leave':
        if (actorUserId) delete participants[actorUserId];
        if (!Object.keys(participants).length) next.status = 'ended';
        break;
      case 'raise_hand':
        if (participants[actorUserId]) participants[actorUserId].raisedHand = true;
        break;
      case 'lower_hand':
        if (participants[actorUserId]) participants[actorUserId].raisedHand = false;
        break;
      case 'host_lock_room':
        next.locked = true;
        break;
      case 'host_unlock_room':
        next.locked = false;
        break;
      case 'host_remove_participant':
        if (targetUserId) delete participants[targetUserId];
        break;
      case 'lobby_admit':
        if (targetUserId && participants[targetUserId]) participants[targetUserId].inLobby = false;
        break;
      case 'lobby_deny':
        if (targetUserId) delete participants[targetUserId];
        break;
      default:
        break;
    }
    next.participants = participants;
    await this.state.storage.put('meeting', next);
    return next;
  }
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
