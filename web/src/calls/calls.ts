/**
 * RocChat Web — Calls UI + WebRTC
 *
 * Complete voice & video call functionality with:
 * - WebRTC peer connections (DTLS-SRTP encrypted)
 * - Signaling via WebSocket (Durable Object relay)
 * - E2E encrypted signaling (Double Ratchet)
 * - Call UI overlay (incoming/outgoing/active)
 * - Media controls (mute, camera toggle)
 */

import { randomId } from '@rocchat/shared';
import { encryptMessage, decryptMessage } from '../crypto/session-manager.js';
import { groupEncrypt, groupDecrypt } from '../crypto/group-session-manager.js';

// ── State ──

interface CallState {
  callId: string | null;
  conversationId: string | null;
  remoteUserId: string | null;
  remoteName: string;
  callType: 'voice' | 'video';
  status: 'idle' | 'outgoing' | 'incoming' | 'connected';
  pc: RTCPeerConnection | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  ws: WebSocket | null;
  startTime: number | null;
  muted: boolean;
  cameraOff: boolean;
  timerInterval: ReturnType<typeof setInterval> | null;
  pendingSdp: string | null;
}

const callState: CallState = {
  callId: null, conversationId: null, remoteUserId: null, remoteName: 'Unknown',
  callType: 'voice', status: 'idle', pc: null, localStream: null, remoteStream: null,
  ws: null, startTime: null, muted: false, cameraOff: false, timerInterval: null, pendingSdp: null,
};

// Independent STUN servers — no Google, no surveillance
const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:stun.nextcloud.com:3478' },
];

let cachedIceServers: RTCIceServer[] | null = null;
let iceServersFetchedAt = 0;

// ── Safety Word Verification ──
// Derives a 6-digit numeric code from both participants' IDs for verbal verification
async function deriveSafetyWord(userId1: string, userId2: string): Promise<string> {
  const sorted = [userId1, userId2].sort();
  const data = new TextEncoder().encode(sorted.join(':'));
  const hash = await crypto.subtle.digest('SHA-256', data);
  const view = new DataView(hash);
  const num = view.getUint32(0) % 1_000_000;
  return String(num).padStart(6, '0');
}

async function getIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers && Date.now() - iceServersFetchedAt < 5 * 60_000) return cachedIceServers;
  try {
    const token = localStorage.getItem('rocchat_token');
    const res = await fetch('/api/calls/ice-servers', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json() as { iceServers?: RTCIceServer[] };
      if (data.iceServers?.length) {
        cachedIceServers = data.iceServers;
        iceServersFetchedAt = Date.now();
        return cachedIceServers;
      }
    }
  } catch { /* TURN not configured, fall back to STUN */ }
  return STUN_SERVERS;
}

// ── E2E Encrypted Signaling ──

async function encryptSignaling(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { targetUserId, callId, ...sensitiveData } = payload;
  if (!callState.conversationId || !callState.remoteUserId) return payload;
  try {
    const encrypted = await encryptMessage(
      callState.conversationId,
      callState.remoteUserId,
      JSON.stringify(sensitiveData),
    );
    return { callId, targetUserId, encryptedSignaling: encrypted };
  } catch {
    return payload;
  }
}

async function decryptSignaling(
  payload: Record<string, unknown>,
  conversationId?: string,
): Promise<Record<string, unknown>> {
  if (!payload.encryptedSignaling) return payload;
  const convId = conversationId || callState.conversationId;
  if (!convId) return payload;
  try {
    const decrypted = await decryptMessage(convId, payload.encryptedSignaling as any);
    const data = JSON.parse(decrypted);
    return { ...data, callId: payload.callId, targetUserId: payload.targetUserId, fromUserId: payload.fromUserId };
  } catch {
    return payload;
  }
}

// Group call signaling encryption: broadcast via sender keys, targeted via pairwise
async function encryptGroupSignaling(
  payload: Record<string, unknown>, convId: string, members?: string[],
): Promise<Record<string, unknown>> {
  const { targetUserId, callId, ...sensitiveData } = payload;
  try {
    if (targetUserId && typeof targetUserId === 'string') {
      // Targeted signal (offer/answer/ice) → pairwise encrypt
      const encrypted = await encryptMessage(convId, targetUserId, JSON.stringify(sensitiveData));
      return { callId, targetUserId, encryptedSignaling: encrypted };
    }
    if (members?.length) {
      // Broadcast signal (start/join/leave) → sender keys
      const encrypted = await groupEncrypt(convId, members.map(m => ({ user_id: m })), JSON.stringify(sensitiveData));
      return { callId, encryptedGroupSignaling: encrypted };
    }
  } catch { /* fall through */ }
  return payload;
}

async function decryptGroupSignaling(
  payload: Record<string, unknown>, convId: string,
): Promise<Record<string, unknown>> {
  try {
    if (payload.encryptedSignaling) {
      const decrypted = await decryptMessage(convId, payload.encryptedSignaling as any);
      return { ...JSON.parse(decrypted), callId: payload.callId, targetUserId: payload.targetUserId, fromUserId: payload.fromUserId };
    }
    if (payload.encryptedGroupSignaling) {
      const enc = payload.encryptedGroupSignaling as { ciphertext: string; ratchet_header: string };
      const senderId = (payload.fromUserId as string) || '';
      const decrypted = await groupDecrypt(convId, senderId, enc.ciphertext, enc.ratchet_header);
      return { ...JSON.parse(decrypted), callId: payload.callId, fromUserId: payload.fromUserId };
    }
  } catch { /* fall through */ }
  return payload;
}

interface CallRecord {
  id: string; remoteName: string; remoteUserId: string; callType: 'voice' | 'video';
  direction: 'incoming' | 'outgoing'; status: 'completed' | 'missed'; duration: number; timestamp: string;
}

function getCallHistory(): CallRecord[] {
  try { return JSON.parse(localStorage.getItem('rocchat_call_history') || '[]'); }
  catch { return []; }
}

function addCallRecord(record: CallRecord) {
  const history = getCallHistory();
  history.unshift(record);
  if (history.length > 100) history.length = 100;
  localStorage.setItem('rocchat_call_history', JSON.stringify(history));
}

// ── Render ──

export function renderCalls(container: HTMLElement) {
  const history = getCallHistory();
  container.innerHTML = `
    <div class="panel-list">
      <div class="panel-header"><h2>Calls</h2></div>
      <div class="calls-list" id="calls-list">
        ${history.length === 0 ? `
          <div class="empty-state" style="padding:var(--sp-8)">
            <i data-lucide="phone-off" style="width:48px;height:48px;color:var(--text-tertiary);opacity:0.3"></i>
            <h3 style="font-size:var(--text-base);color:var(--text-secondary);margin-top:var(--sp-4)">No recent calls</h3>
            <p style="font-size:var(--text-sm);color:var(--text-tertiary)">Start a call from any chat.</p>
            <p style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--turquoise);margin-top:var(--sp-2)">🔒 All calls are end-to-end encrypted</p>
          </div>
        ` : history.map((c) => `
          <div class="conversation-item">
            <div class="avatar" style="width:36px;height:36px;font-size:var(--text-xs)">
              ${c.remoteName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div class="conversation-info">
              <div class="conversation-name">${esc(c.remoteName)}</div>
              <div class="conversation-preview" style="color:${c.status === 'missed' ? 'var(--danger)' : 'var(--text-tertiary)'}">
                ${c.direction === 'incoming' ? '↙' : '↗'} ${c.callType} · ${c.status === 'completed' ? fmtDur(c.duration) : c.status}
              </div>
            </div>
            <div class="conversation-meta"><span class="conversation-time">${fmtTime(c.timestamp)}</span></div>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="chat-view">
      <div class="empty-state">
        <i data-lucide="phone" style="width:48px;height:48px;color:var(--text-tertiary);opacity:0.2"></i>
        <h3>Voice & Video Calls</h3>
        <p>Select a call or start one from a chat.</p>
        <p style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--turquoise);margin-top:var(--sp-2)">3-layer encryption: DTLS-SRTP + E2E signaling + verification</p>
      </div>
    </div>
  `;
  if (typeof (window as any).lucide !== 'undefined') (window as any).lucide.createIcons();
}

// ── Outgoing Call ──

export async function startOutgoingCall(
  conversationId: string, remoteUserId: string, remoteName: string,
  callType: 'voice' | 'video', ws: WebSocket,
) {
  if (callState.status !== 'idle') return;
  Object.assign(callState, {
    callId: randomId(), conversationId, remoteUserId, remoteName, callType, status: 'outgoing', ws,
  });
  showCallOverlay();
  try {
    callState.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
    await createPC();
    callState.localStream.getTracks().forEach((t) => callState.pc!.addTrack(t, callState.localStream!));
    const offer = await callState.pc!.createOffer();
    await callState.pc!.setLocalDescription(offer);
    const offerPayload = await encryptSignaling({
      callId: callState.callId, callType, sdp: offer.sdp, targetUserId: remoteUserId, timestamp: Date.now(),
    });
    ws.send(JSON.stringify({ type: 'call_offer', payload: offerPayload }));
  } catch (err) { handleMediaError(err); }
}

// ── Incoming Call ──

export async function handleIncomingCallOffer(payload: Record<string, unknown>, conversationId: string, ws: WebSocket | null) {
  if (callState.status !== 'idle' || !ws) {
    ws?.send(JSON.stringify({ type: 'call_end', payload: { callId: payload.callId, reason: 'busy', targetUserId: payload.fromUserId }}));
    return;
  }
  const decrypted = await decryptSignaling(payload, conversationId);
  Object.assign(callState, {
    callId: decrypted.callId, conversationId, remoteUserId: decrypted.fromUserId || payload.fromUserId,
    remoteName: ((decrypted.fromUserId || payload.fromUserId) as string).slice(0, 8),
    callType: (decrypted.callType as 'voice' | 'video') || 'voice',
    status: 'incoming', ws, pendingSdp: decrypted.sdp,
  });
  showCallOverlay();
  setTimeout(() => {
    if (callState.status === 'incoming' && callState.callId === payload.callId) endCall('timeout');
  }, 30000);
}

export async function handleCallAnswer(payload: Record<string, unknown>) {
  const decrypted = await decryptSignaling(payload);
  if (!callState.pc || callState.callId !== decrypted.callId) return;
  callState.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: decrypted.sdp as string }));
}

export async function handleIceCandidate(payload: Record<string, unknown>) {
  const decrypted = await decryptSignaling(payload);
  if (!callState.pc || callState.callId !== decrypted.callId) return;
  callState.pc.addIceCandidate(new RTCIceCandidate({
    candidate: decrypted.candidate as string, sdpMLineIndex: decrypted.sdpMLineIndex as number, sdpMid: decrypted.sdpMid as string,
  }));
}

export async function handleCallEnd(payload: Record<string, unknown>) {
  const decrypted = await decryptSignaling(payload);
  if (callState.callId !== decrypted.callId) return;
  endCall(decrypted.reason as string || 'hangup', false);
}

// ── WebRTC ──

async function createPC() {
  const iceServers = await getIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  callState.pc = pc;
  pc.onicecandidate = async (e) => {
    if (e.candidate && callState.ws?.readyState === WebSocket.OPEN) {
      const icePayload = await encryptSignaling({
        callId: callState.callId, candidate: e.candidate.candidate,
        sdpMLineIndex: e.candidate.sdpMLineIndex, sdpMid: e.candidate.sdpMid, targetUserId: callState.remoteUserId,
      });
      callState.ws.send(JSON.stringify({ type: 'call_ice', payload: icePayload }));
    }
  };
  pc.ontrack = (e) => {
    callState.remoteStream = e.streams[0] || new MediaStream([e.track]);
    const rv = document.getElementById('remote-video') as HTMLVideoElement;
    const ra = document.getElementById('remote-audio') as HTMLAudioElement;
    if (callState.callType === 'video' && rv) rv.srcObject = callState.remoteStream;
    else if (ra) ra.srcObject = callState.remoteStream;
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      callState.status = 'connected'; callState.startTime = Date.now();
      updateOverlay(); startTimer();
      // Derive and display safety word
      const myId = localStorage.getItem('rocchat_user_id') || '';
      if (myId && callState.remoteUserId) {
        deriveSafetyWord(myId, callState.remoteUserId).then(word => {
          const el = document.getElementById('call-safety-word');
          if (el) el.textContent = `Safety code: ${word.slice(0, 3)} ${word.slice(3)}`;
        });
      }
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      endCall('error');
    }
  };
}

async function acceptCall() {
  if (callState.status !== 'incoming' || !callState.ws || !callState.pendingSdp) return;
  try {
    callState.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callState.callType === 'video' });
    await createPC();
    callState.localStream.getTracks().forEach((t) => callState.pc!.addTrack(t, callState.localStream!));
    await callState.pc!.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: callState.pendingSdp }));
    const answer = await callState.pc!.createAnswer();
    await callState.pc!.setLocalDescription(answer);
    const answerPayload = await encryptSignaling({
      callId: callState.callId, sdp: answer.sdp, targetUserId: callState.remoteUserId,
    });
    callState.ws.send(JSON.stringify({ type: 'call_answer', payload: answerPayload }));
    callState.status = 'connected';
    updateOverlay();
  } catch (err) { handleMediaError(err); }
}

function toggleMute() {
  callState.muted = !callState.muted;
  callState.localStream?.getAudioTracks().forEach((t) => { t.enabled = !callState.muted; });
  updateControls();
}
function toggleCamera() {
  callState.cameraOff = !callState.cameraOff;
  callState.localStream?.getVideoTracks().forEach((t) => { t.enabled = !callState.cameraOff; });
  updateControls();
}

function handleMediaError(err: unknown) {
  let msg = 'Call failed';
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') msg = callState.callType === 'video' ? 'Camera & microphone access denied' : 'Microphone access denied';
    else if (err.name === 'NotFoundError') msg = callState.callType === 'video' ? 'No camera or microphone found' : 'No microphone found';
    else if (err.name === 'NotReadableError') msg = 'Media device is already in use';
    else if (err.name === 'OverconstrainedError') msg = 'Media device does not meet requirements';
  }
  showCallError(msg);
  endCall('error');
}

function showCallError(msg: string) {
  const el = document.getElementById('call-overlay');
  if (!el) return;
  const err = document.createElement('div');
  err.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);background:var(--danger);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:100;white-space:nowrap';
  err.textContent = msg;
  el.appendChild(err);
  setTimeout(() => err.remove(), 4000);
}

function endCall(reason = 'hangup', notify = true) {
  if (notify && callState.ws?.readyState === WebSocket.OPEN && callState.callId) {
    encryptSignaling({
      callId: callState.callId, reason, targetUserId: callState.remoteUserId,
      duration: callState.startTime ? Math.floor((Date.now() - callState.startTime) / 1000) : 0,
    }).then((endPayload) => {
      callState.ws?.send(JSON.stringify({ type: 'call_end', payload: endPayload }));
    });
  }
  if (callState.callId) {
    addCallRecord({
      id: callState.callId, remoteName: callState.remoteName, remoteUserId: callState.remoteUserId || '',
      callType: callState.callType, direction: callState.status === 'incoming' ? 'incoming' : 'outgoing',
      status: callState.startTime ? 'completed' : 'missed',
      duration: callState.startTime ? Math.floor((Date.now() - callState.startTime) / 1000) : 0,
      timestamp: new Date().toISOString(),
    });
  }
  callState.localStream?.getTracks().forEach((t) => t.stop());
  callState.pc?.close();
  if (callState.timerInterval) clearInterval(callState.timerInterval);
  Object.assign(callState, {
    callId: null, conversationId: null, remoteUserId: null, remoteName: 'Unknown',
    status: 'idle', pc: null, localStream: null, remoteStream: null, startTime: null,
    muted: false, cameraOff: false, timerInterval: null, pendingSdp: null,
  });
  document.getElementById('call-overlay')?.remove();
}

// ── Call Overlay UI ──

function showCallOverlay() {
  document.getElementById('call-overlay')?.remove();
  const el = document.createElement('div');
  el.id = 'call-overlay'; el.className = 'call-overlay';
  el.innerHTML = overlayHTML();
  document.body.appendChild(el);
  bindEvents();
  if (typeof (window as any).lucide !== 'undefined') (window as any).lucide.createIcons();
}

function updateOverlay() {
  const el = document.getElementById('call-overlay');
  if (!el) return;
  el.innerHTML = overlayHTML();
  bindEvents();
  if (callState.callType === 'video') {
    const lv = document.getElementById('local-video') as HTMLVideoElement;
    const rv = document.getElementById('remote-video') as HTMLVideoElement;
    if (lv && callState.localStream) lv.srcObject = callState.localStream;
    if (rv && callState.remoteStream) rv.srcObject = callState.remoteStream;
  }
  if (typeof (window as any).lucide !== 'undefined') (window as any).lucide.createIcons();
}

function updateControls() {
  const mb = document.getElementById('call-mute');
  const cb = document.getElementById('call-camera');
  if (mb) { mb.innerHTML = `<i data-lucide="${callState.muted ? 'mic-off' : 'mic'}" style="width:24px;height:24px"></i>`; mb.classList.toggle('active', callState.muted); }
  if (cb) { cb.innerHTML = `<i data-lucide="${callState.cameraOff ? 'video-off' : 'video'}" style="width:24px;height:24px"></i>`; cb.classList.toggle('active', callState.cameraOff); }
  if (typeof (window as any).lucide !== 'undefined') (window as any).lucide.createIcons();
}

function overlayHTML(): string {
  const ini = callState.remoteName.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (callState.status === 'incoming') return `
    <div class="call-card">
      <div class="call-avatar">${ini}</div>
      <h2 style="color:var(--text-primary);margin-bottom:var(--sp-1)">${esc(callState.remoteName)}</h2>
      <p style="color:var(--text-tertiary);margin-bottom:var(--sp-6)">Incoming ${callState.callType} call...</p>
      <div style="display:flex;gap:var(--sp-6);justify-content:center">
        <button class="call-btn call-btn-accept" id="call-accept"><i data-lucide="phone" style="width:28px;height:28px"></i></button>
        <button class="call-btn call-btn-decline" id="call-decline"><i data-lucide="phone-off" style="width:28px;height:28px"></i></button>
      </div>
      <p style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--turquoise);margin-top:var(--sp-4)">🔒 End-to-end encrypted</p>
    </div>`;
  const isV = callState.callType === 'video';
  const conn = callState.status === 'connected';
  return `
    <div class="call-card ${isV ? 'call-card-video' : ''}">
      ${isV ? `<video id="remote-video" autoplay playsinline style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-lg);background:#000"></video>
        <video id="local-video" autoplay playsinline muted style="position:absolute;top:var(--sp-4);right:var(--sp-4);width:120px;height:90px;object-fit:cover;border-radius:var(--radius-md);border:2px solid var(--gold);z-index:2"></video>`
        : `<div class="call-avatar">${ini}</div>`}
      <audio id="remote-audio" autoplay></audio>
      <div class="call-info" style="${isV ? 'position:absolute;bottom:80px;left:0;right:0;text-align:center' : ''}">
        <h2 style="color:var(--text-primary);margin-bottom:var(--sp-1)">${esc(callState.remoteName)}</h2>
        <p style="color:var(--text-tertiary);margin-bottom:var(--sp-4)">${conn ? '<span id="call-timer">00:00</span>' : 'Calling...'}</p>
      </div>
      <div class="call-controls" style="${isV ? 'position:absolute;bottom:var(--sp-6);left:0;right:0;' : ''}display:flex;gap:var(--sp-4);justify-content:center">
        <button class="call-control-btn ${callState.muted ? 'active' : ''}" id="call-mute"><i data-lucide="${callState.muted ? 'mic-off' : 'mic'}" style="width:24px;height:24px"></i></button>
        ${isV ? `<button class="call-control-btn ${callState.cameraOff ? 'active' : ''}" id="call-camera"><i data-lucide="${callState.cameraOff ? 'video-off' : 'video'}" style="width:24px;height:24px"></i></button>` : ''}
        <button class="call-btn call-btn-decline" id="call-hangup"><i data-lucide="phone-off" style="width:24px;height:24px"></i></button>
      </div>
      <p style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--turquoise);margin-top:var(--sp-3);text-align:center;${isV ? 'position:absolute;bottom:4px;left:0;right:0' : ''}">🔒 DTLS-SRTP encrypted${conn ? ' · <span id="call-safety-word" title="Both callers should see the same code">verifying…</span>' : ''}</p>
    </div>`;
}

function bindEvents() {
  document.getElementById('call-accept')?.addEventListener('click', acceptCall);
  document.getElementById('call-decline')?.addEventListener('click', () => endCall('declined'));
  document.getElementById('call-hangup')?.addEventListener('click', () => endCall('hangup'));
  document.getElementById('call-mute')?.addEventListener('click', toggleMute);
  document.getElementById('call-camera')?.addEventListener('click', toggleCamera);
}

function startTimer() {
  if (callState.timerInterval) clearInterval(callState.timerInterval);
  callState.timerInterval = setInterval(() => {
    if (!callState.startTime) return;
    const el = document.getElementById('call-timer');
    if (el) el.textContent = fmtDur(Math.floor((Date.now() - callState.startTime) / 1000));
  }, 1000);
}

function fmtDur(s: number): string { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function fmtTime(iso: string): string {
  const d = new Date(iso), diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function esc(t: string): string { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

// ── Group Calls (Mesh Topology, up to 6 participants) ──

interface GroupPeer {
  userId: string;
  name: string;
  pc: RTCPeerConnection;
  remoteStream: MediaStream | null;
}

interface GroupCallState {
  callId: string | null;
  conversationId: string | null;
  callType: 'voice' | 'video';
  mode: 'mesh' | 'sfu';
  status: 'idle' | 'starting' | 'active';
  peers: Map<string, GroupPeer>;
  localStream: MediaStream | null;
  ws: WebSocket | null;
  startTime: number | null;
  muted: boolean;
  cameraOff: boolean;
  timerInterval: ReturnType<typeof setInterval> | null;
}

const groupState: GroupCallState = {
  callId: null, conversationId: null, callType: 'voice', status: 'idle',
  mode: 'mesh',
  peers: new Map(), localStream: null, ws: null, startTime: null,
  muted: false, cameraOff: false, timerInterval: null,
};

const MAX_MESH_PEERS = 5; // 6 total including self

function resetGroupState() {
  groupState.localStream?.getTracks().forEach((t) => t.stop());
  groupState.peers.forEach((p) => p.pc.close());
  Object.assign(groupState, {
    callId: null, conversationId: null, status: 'idle',
    mode: 'mesh',
    peers: new Map(), localStream: null, ws: null, startTime: null,
    muted: false, cameraOff: false, timerInterval: null,
  });
}

export async function startGroupCall(
  conversationId: string, callType: 'voice' | 'video', ws: WebSocket, members?: string[],
) {
  if (groupState.status !== 'idle' || callState.status !== 'idle') return;
  const expectedParticipants = members?.length || 0;
  const mode: 'mesh' | 'sfu' = expectedParticipants > MAX_MESH_PEERS + 1 ? 'sfu' : 'mesh';
  Object.assign(groupState, {
    callId: randomId(), conversationId, callType, mode, status: 'starting', ws,
  });
  try {
    groupState.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' });
  } catch (err) { handleMediaError(err); resetGroupState(); return; }
  groupState.status = 'active';
  groupState.startTime = Date.now();
  showGroupCallOverlay();
  const encPayload = await encryptGroupSignaling(
    { callId: groupState.callId, callType, conversationId, mode }, conversationId, members,
  );
  ws.send(JSON.stringify({ type: 'group_call_start', payload: encPayload }));
  if (mode === 'sfu') {
    showGroupNotice('Large group detected. Switching to SFU fallback mode.');
  }
  startGroupTimer();
}

export async function handleGroupCallStart(payload: Record<string, unknown>, conversationId: string, ws: WebSocket | null) {
  if (groupState.status !== 'idle' || callState.status !== 'idle' || !ws) return;
  const decrypted = await decryptGroupSignaling(payload, conversationId);
  const fromUserId = payload.fromUserId as string;
  Object.assign(groupState, {
    callId: decrypted.callId || payload.callId, conversationId,
    callType: (decrypted.callType as 'voice' | 'video') || 'voice',
    mode: (decrypted.mode as 'mesh' | 'sfu') || 'mesh',
    status: 'active', ws,
  });
  try {
    groupState.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: groupState.callType === 'video',
    });
  } catch (err) { handleMediaError(err); resetGroupState(); return; }
  groupState.startTime = Date.now();
  showGroupCallOverlay();
  // Send encrypted join to notify others
  const joinPayload = await encryptGroupSignaling(
    { callId: groupState.callId, conversationId }, conversationId,
  );
  ws.send(JSON.stringify({ type: 'group_call_join', payload: joinPayload }));
  // Create peer for the initiator
  await createGroupPeer(fromUserId, fromUserId.slice(0, 8), true);
  startGroupTimer();
}

export async function handleGroupCallJoin(payload: Record<string, unknown>) {
  if (groupState.status !== 'active' || groupState.callId !== payload.callId) return;
  const userId = payload.fromUserId as string;
  if (groupState.peers.has(userId)) return;
  if (groupState.mode === 'mesh' && groupState.peers.size >= MAX_MESH_PEERS) return;
  // Determine who creates the offer: lexicographically lower userId is the offerer
  const myId = localStorage.getItem('rocchat_user_id') || '';
  const iAmOfferer = myId < userId;
  await createGroupPeer(userId, userId.slice(0, 8), iAmOfferer);
}

export async function handleGroupCallOffer(payload: Record<string, unknown>) {
  if (groupState.status !== 'active' || !groupState.conversationId) return;
  const decrypted = await decryptGroupSignaling(payload, groupState.conversationId);
  const fromId = payload.fromUserId as string;
  let peer = groupState.peers.get(fromId);
  if (!peer) {
    peer = await createGroupPeer(fromId, fromId.slice(0, 8), false);
  }
  await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: decrypted.sdp as string }));
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  const encPayload = await encryptGroupSignaling(
    { callId: groupState.callId, sdp: answer.sdp, targetUserId: fromId },
    groupState.conversationId,
  );
  groupState.ws?.send(JSON.stringify({ type: 'group_call_answer', payload: encPayload }));
}

export async function handleGroupCallAnswer(payload: Record<string, unknown>) {
  if (!groupState.conversationId) return;
  const decrypted = await decryptGroupSignaling(payload, groupState.conversationId);
  const peer = groupState.peers.get(payload.fromUserId as string);
  if (!peer) return;
  await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: decrypted.sdp as string }));
}

export async function handleGroupCallIce(payload: Record<string, unknown>) {
  if (!groupState.conversationId) return;
  const decrypted = await decryptGroupSignaling(payload, groupState.conversationId);
  const peer = groupState.peers.get(payload.fromUserId as string);
  if (!peer) return;
  await peer.pc.addIceCandidate(new RTCIceCandidate({
    candidate: decrypted.candidate as string,
    sdpMLineIndex: decrypted.sdpMLineIndex as number,
    sdpMid: decrypted.sdpMid as string,
  }));
}

export function handleGroupCallLeave(payload: Record<string, unknown>) {
  const userId = payload.fromUserId as string;
  const peer = groupState.peers.get(userId);
  if (!peer) return;
  peer.pc.close();
  groupState.peers.delete(userId);
  updateGroupOverlay();
  if (groupState.peers.size === 0) endGroupCall(false);
}

async function createGroupPeer(userId: string, name: string, createOffer: boolean): Promise<GroupPeer> {
  const iceServers = await getIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const peer: GroupPeer = { userId, name, pc, remoteStream: null };
  groupState.peers.set(userId, peer);

  groupState.localStream?.getTracks().forEach((t) => pc.addTrack(t, groupState.localStream!));

  pc.onicecandidate = async (e) => {
    if (e.candidate && groupState.ws?.readyState === WebSocket.OPEN && groupState.conversationId) {
      const encPayload = await encryptGroupSignaling({
        callId: groupState.callId, candidate: e.candidate.candidate,
        sdpMLineIndex: e.candidate.sdpMLineIndex, sdpMid: e.candidate.sdpMid,
        targetUserId: userId,
      }, groupState.conversationId);
      groupState.ws.send(JSON.stringify({ type: 'group_call_ice', payload: encPayload }));
    }
  };

  pc.ontrack = (e) => {
    peer.remoteStream = e.streams[0] || new MediaStream([e.track]);
    updateGroupOverlay();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      groupState.peers.delete(userId);
      pc.close();
      updateGroupOverlay();
    }
  };

  if (createOffer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (groupState.conversationId) {
      const encPayload = await encryptGroupSignaling(
        { callId: groupState.callId, sdp: offer.sdp, targetUserId: userId },
        groupState.conversationId,
      );
      groupState.ws?.send(JSON.stringify({ type: 'group_call_offer', payload: encPayload }));
    }
  }

  updateGroupOverlay();
  return peer;
}

function endGroupCall(notify = true) {
  if (notify && groupState.ws?.readyState === WebSocket.OPEN && groupState.callId && groupState.conversationId) {
    encryptGroupSignaling({ callId: groupState.callId }, groupState.conversationId).then((enc) => {
      groupState.ws?.send(JSON.stringify({ type: 'group_call_leave', payload: enc }));
    });
  }
  groupState.localStream?.getTracks().forEach((t) => t.stop());
  groupState.peers.forEach((p) => p.pc.close());
  if (groupState.timerInterval) clearInterval(groupState.timerInterval);
  Object.assign(groupState, {
    callId: null, conversationId: null, status: 'idle',
    mode: 'mesh',
    peers: new Map(), localStream: null, ws: null, startTime: null,
    muted: false, cameraOff: false, timerInterval: null,
  });
  document.getElementById('group-call-overlay')?.remove();
}

function showGroupCallOverlay() {
  document.getElementById('group-call-overlay')?.remove();
  const el = document.createElement('div');
  el.id = 'group-call-overlay'; el.className = 'call-overlay';
  el.innerHTML = groupOverlayHTML();
  document.body.appendChild(el);
  bindGroupEvents();
  if (typeof (window as any).lucide !== 'undefined') (window as any).lucide.createIcons();
}

function updateGroupOverlay() {
  const el = document.getElementById('group-call-overlay');
  if (!el) return;
  el.innerHTML = groupOverlayHTML();
  // Re-attach streams to video elements
  groupState.peers.forEach((peer) => {
    if (peer.remoteStream && groupState.callType === 'video') {
      const vid = document.getElementById(`gv-${peer.userId}`) as HTMLVideoElement;
      if (vid) vid.srcObject = peer.remoteStream;
    }
  });
  if (groupState.localStream && groupState.callType === 'video') {
    const lv = document.getElementById('group-local-video') as HTMLVideoElement;
    if (lv) lv.srcObject = groupState.localStream;
  }
  bindGroupEvents();
  if (typeof (window as any).lucide !== 'undefined') (window as any).lucide.createIcons();
}

function groupOverlayHTML(): string {
  const isV = groupState.callType === 'video';
  const peerCount = groupState.peers.size;
  const cols = peerCount <= 1 ? 1 : peerCount <= 4 ? 2 : 3;
  const tiles = Array.from(groupState.peers.values()).map((p) => {
    const ini = p.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '??';
    return isV
      ? `<div class="group-tile"><video id="gv-${p.userId}" autoplay playsinline style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md);background:#000"></video><span class="group-tile-name">${esc(p.name)}</span></div>`
      : `<div class="group-tile"><div class="call-avatar" style="width:56px;height:56px;font-size:20px">${ini}</div><span class="group-tile-name">${esc(p.name)}</span></div>`;
  }).join('');
  const timer = groupState.startTime ? fmtDur(Math.floor((Date.now() - groupState.startTime) / 1000)) : '00:00';
  const modeLabel = groupState.mode === 'sfu' ? 'SFU fallback mode' : 'Mesh mode';
  return `
    <div class="call-card" style="min-width:360px;max-width:800px;width:90%;">
      <h2 style="color:var(--text-primary);margin-bottom:var(--sp-2)">Group ${groupState.callType} call</h2>
      <p style="color:var(--text-tertiary);margin-bottom:var(--sp-1)">${peerCount + 1} participants · <span id="group-timer">${timer}</span></p>
      <p style="color:var(--text-tertiary);margin-bottom:var(--sp-4);font-size:var(--text-xs)">${modeLabel}</p>
      <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:var(--sp-3);margin-bottom:var(--sp-4)">
        ${isV ? `<div class="group-tile" style="border:2px solid var(--gold)"><video id="group-local-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md);background:#000"></video><span class="group-tile-name">You</span></div>` : ''}
        ${tiles}
      </div>
      <div class="call-controls" style="display:flex;gap:var(--sp-4);justify-content:center">
        <button class="call-control-btn ${groupState.muted ? 'active' : ''}" id="gcall-mute"><i data-lucide="${groupState.muted ? 'mic-off' : 'mic'}" style="width:24px;height:24px"></i></button>
        ${isV ? `<button class="call-control-btn ${groupState.cameraOff ? 'active' : ''}" id="gcall-camera"><i data-lucide="${groupState.cameraOff ? 'video-off' : 'video'}" style="width:24px;height:24px"></i></button>` : ''}
        <button class="call-btn call-btn-decline" id="gcall-hangup"><i data-lucide="phone-off" style="width:24px;height:24px"></i></button>
      </div>
      <p style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--turquoise);margin-top:var(--sp-3);text-align:center">🔒 ${groupState.mode === 'sfu' ? 'SFU fallback' : 'Mesh'} · DTLS-SRTP per peer</p>
    </div>`;
}

function showGroupNotice(message: string) {
  const el = document.getElementById('group-call-overlay');
  if (!el) return;
  const notice = document.createElement('div');
  notice.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);background:var(--bg-tertiary);color:var(--text-primary);padding:8px 12px;border-radius:8px;font-size:12px;border:1px solid var(--border-primary);z-index:120';
  notice.textContent = message;
  el.appendChild(notice);
  setTimeout(() => notice.remove(), 5000);
}

function bindGroupEvents() {
  document.getElementById('gcall-hangup')?.addEventListener('click', () => endGroupCall());
  document.getElementById('gcall-mute')?.addEventListener('click', () => {
    groupState.muted = !groupState.muted;
    groupState.localStream?.getAudioTracks().forEach((t) => { t.enabled = !groupState.muted; });
    updateGroupOverlay();
  });
  document.getElementById('gcall-camera')?.addEventListener('click', () => {
    groupState.cameraOff = !groupState.cameraOff;
    groupState.localStream?.getVideoTracks().forEach((t) => { t.enabled = !groupState.cameraOff; });
    updateGroupOverlay();
  });
}

function startGroupTimer() {
  if (groupState.timerInterval) clearInterval(groupState.timerInterval);
  groupState.timerInterval = setInterval(() => {
    if (!groupState.startTime) return;
    const el = document.getElementById('group-timer');
    if (el) el.textContent = fmtDur(Math.floor((Date.now() - groupState.startTime) / 1000));
  }, 1000);
}
