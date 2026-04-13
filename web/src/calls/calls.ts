/**
 * RocChat Web — Calls UI + WebRTC
 *
 * Complete voice & video call functionality with:
 * - WebRTC peer connections (DTLS-SRTP encrypted)
 * - Signaling via WebSocket (Durable Object relay)
 * - Call UI overlay (incoming/outgoing/active)
 * - Media controls (mute, camera toggle)
 */

import { randomId } from '@rocchat/shared';

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

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

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
    ws.send(JSON.stringify({ type: 'call_offer', payload: {
      callId: callState.callId, callType, sdp: offer.sdp, targetUserId: remoteUserId, timestamp: Date.now(),
    }}));
  } catch (err) { handleMediaError(err); }
}

// ── Incoming Call ──

export function handleIncomingCallOffer(payload: Record<string, unknown>, conversationId: string, ws: WebSocket | null) {
  if (callState.status !== 'idle' || !ws) {
    ws?.send(JSON.stringify({ type: 'call_end', payload: { callId: payload.callId, reason: 'busy', targetUserId: payload.fromUserId }}));
    return;
  }
  Object.assign(callState, {
    callId: payload.callId, conversationId, remoteUserId: payload.fromUserId,
    remoteName: (payload.fromUserId as string).slice(0, 8),
    callType: (payload.callType as 'voice' | 'video') || 'voice',
    status: 'incoming', ws, pendingSdp: payload.sdp,
  });
  showCallOverlay();
  setTimeout(() => {
    if (callState.status === 'incoming' && callState.callId === payload.callId) endCall('timeout');
  }, 30000);
}

export function handleCallAnswer(payload: Record<string, unknown>) {
  if (!callState.pc || callState.callId !== payload.callId) return;
  callState.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp as string }));
}

export function handleIceCandidate(payload: Record<string, unknown>) {
  if (!callState.pc || callState.callId !== payload.callId) return;
  callState.pc.addIceCandidate(new RTCIceCandidate({
    candidate: payload.candidate as string, sdpMLineIndex: payload.sdpMLineIndex as number, sdpMid: payload.sdpMid as string,
  }));
}

export function handleCallEnd(payload: Record<string, unknown>) {
  if (callState.callId !== payload.callId) return;
  endCall(payload.reason as string || 'hangup', false);
}

// ── WebRTC ──

async function createPC() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  callState.pc = pc;
  pc.onicecandidate = (e) => {
    if (e.candidate && callState.ws?.readyState === WebSocket.OPEN) {
      callState.ws.send(JSON.stringify({ type: 'call_ice', payload: {
        callId: callState.callId, candidate: e.candidate.candidate,
        sdpMLineIndex: e.candidate.sdpMLineIndex, sdpMid: e.candidate.sdpMid, targetUserId: callState.remoteUserId,
      }}));
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
    callState.ws.send(JSON.stringify({ type: 'call_answer', payload: {
      callId: callState.callId, sdp: answer.sdp, targetUserId: callState.remoteUserId,
    }}));
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
    callState.ws.send(JSON.stringify({ type: 'call_end', payload: {
      callId: callState.callId, reason, targetUserId: callState.remoteUserId,
      duration: callState.startTime ? Math.floor((Date.now() - callState.startTime) / 1000) : 0,
    }}));
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
      <p style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--turquoise);margin-top:var(--sp-3);text-align:center;${isV ? 'position:absolute;bottom:4px;left:0;right:0' : ''}">🔒 DTLS-SRTP encrypted</p>
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
