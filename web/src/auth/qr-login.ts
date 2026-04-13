/**
 * RocChat Web — QR Code Login
 *
 * Generates a QR code with Roc Bird branding, polls backend until mobile authorizes.
 * Uses a minimal QR code generator (no external dependency).
 */

import * as api from '../api.js';

// ── Roc Bird SVG for QR center overlay ──
const ROC_BIRD_QR = `<svg viewBox="0 0 64 64" width="56" height="56">
  <defs>
    <linearGradient id="qb-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0D1117"/><stop offset="50%" stop-color="#161B22"/><stop offset="100%" stop-color="#0D1117"/>
    </linearGradient>
    <linearGradient id="qb-body" x1="30%" y1="0%" x2="70%" y2="100%">
      <stop offset="0%" stop-color="#fef3c7"/><stop offset="40%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <linearGradient id="qb-wL" x1="100%" y1="30%" x2="0%" y2="80%">
      <stop offset="0%" stop-color="#fbbf24"/><stop offset="50%" stop-color="#d97706"/><stop offset="100%" stop-color="#92400e"/>
    </linearGradient>
    <linearGradient id="qb-wR" x1="0%" y1="30%" x2="100%" y2="80%">
      <stop offset="0%" stop-color="#fbbf24"/><stop offset="50%" stop-color="#d97706"/><stop offset="100%" stop-color="#92400e"/>
    </linearGradient>
    <linearGradient id="qb-head" x1="30%" y1="0%" x2="70%" y2="100%">
      <stop offset="0%" stop-color="#fffbeb"/><stop offset="100%" stop-color="#fbbf24"/>
    </linearGradient>
    <radialGradient id="qb-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#D4AF37" stop-opacity="0.15"/><stop offset="100%" stop-color="transparent"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#qb-bg)"/>
  <rect width="64" height="64" rx="14" fill="url(#qb-glow)"/>
  <rect x="1" y="1" width="62" height="62" rx="13" fill="none" stroke="rgba(212,175,55,0.25)" stroke-width="1"/>
  <g transform="translate(32,33) scale(0.14)">
    <path d="M-18,-15 C-50,-55 -95,-100 -155,-130 C-168,-135 -185,-132 -195,-125 C-180,-110 -160,-95 -140,-80 C-160,-90 -182,-95 -200,-92 C-185,-75 -165,-60 -140,-48 C-158,-55 -175,-55 -192,-50 C-170,-35 -148,-22 -120,-15 C-138,-18 -155,-18 -168,-12 C-145,-2 -118,5 -85,8 C-55,10 -30,2 -15,-5 Z" fill="url(#qb-wL)"/>
    <path d="M18,-15 C50,-55 95,-100 155,-130 C168,-135 185,-132 195,-125 C180,-110 160,-95 140,-80 C160,-90 182,-95 200,-92 C185,-75 165,-60 140,-48 C158,-55 175,-55 192,-50 C170,-35 148,-22 120,-15 C138,-18 155,-18 168,-12 C145,-2 118,5 85,8 C55,10 30,2 15,-5 Z" fill="url(#qb-wR)"/>
    <ellipse cx="0" cy="18" rx="26" ry="52" fill="url(#qb-body)"/>
    <ellipse cx="0" cy="5" rx="16" ry="28" fill="#fef3c7" opacity="0.35"/>
    <ellipse cx="0" cy="-42" rx="19" ry="21" fill="url(#qb-head)"/>
    <path d="M-3,-62 C-6,-78 -2,-88 0,-92 C2,-88 6,-78 3,-62" fill="#d97706" opacity="0.8"/>
    <ellipse cx="-7" cy="-44" rx="4" ry="4.5" fill="#fffbeb"/>
    <ellipse cx="7" cy="-44" rx="4" ry="4.5" fill="#fffbeb"/>
    <ellipse cx="-7" cy="-44" rx="2.5" ry="3" fill="#78350f"/>
    <ellipse cx="7" cy="-44" rx="2.5" ry="3" fill="#78350f"/>
    <circle cx="-6.5" cy="-45" r="1" fill="white" opacity="0.8"/>
    <circle cx="7.5" cy="-45" r="1" fill="white" opacity="0.8"/>
    <path d="M0,-36 L-4,-28 C-2,-24 2,-24 4,-28 L0,-36 Z" fill="#92400e"/>
  </g>
</svg>`;

// ── Minimal QR Code generator (byte mode, auto version) ──

function generateQRCodeSVG(data: string, size: number): string {
  const modules = encodeQR(data);
  const moduleCount = modules.length;
  const cellSize = size / moduleCount;

  // Calculate center zone to clear for Roc Bird overlay
  const birdSize = 56;
  const birdCells = Math.ceil(birdSize / cellSize) + 4; // extra quiet zone
  const centerStart = Math.floor((moduleCount - birdCells) / 2);
  const centerEnd = centerStart + birdCells;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;
  svg += `<rect width="${size}" height="${size}" rx="12" fill="white"/>`;

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (modules[row][col]) {
        // Skip center zone for bird overlay
        if (row >= centerStart && row < centerEnd && col >= centerStart && col < centerEnd) continue;
        // Use rounded dots for modern look
        const cx = col * cellSize + cellSize / 2;
        const cy = row * cellSize + cellSize / 2;
        const r = cellSize * 0.42;
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0D1117"/>`;
      }
    }
  }

  // Finder pattern styling (colored corners)
  const finderPositions = [
    [0, 0], [0, moduleCount - 7], [moduleCount - 7, 0]
  ];
  for (const [fr, fc] of finderPositions) {
    const x = fc * cellSize;
    const y = fr * cellSize;
    const s = 7 * cellSize;
    // Gold outer ring
    svg += `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${cellSize}" fill="#D4AF37"/>`;
    svg += `<rect x="${x + cellSize}" y="${y + cellSize}" width="${s - 2 * cellSize}" height="${s - 2 * cellSize}" rx="${cellSize * 0.5}" fill="white"/>`;
    svg += `<rect x="${x + 2 * cellSize}" y="${y + 2 * cellSize}" width="${3 * cellSize}" height="${3 * cellSize}" rx="${cellSize * 0.5}" fill="#0D1117"/>`;
  }

  // Roc Bird overlay in center
  const birdX = (size - birdSize) / 2;
  const birdY = (size - birdSize) / 2;
  svg += `<g transform="translate(${birdX},${birdY})">${ROC_BIRD_QR.replace(/<svg[^>]*>/, '').replace('</svg>', '')}</g>`;

  svg += '</svg>';
  return svg;
}

// ── QR Encoding (Version 2, Byte mode, ECC L) ──

function encodeQR(data: string): boolean[][] {
  const bytes = new TextEncoder().encode(data);
  const version = bytes.length <= 20 ? 2 : bytes.length <= 34 ? 3 : bytes.length <= 78 ? 5 : 7;
  const size = version * 4 + 17;
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));

  // Place finder patterns
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, size - 7, 0);
  placeFinder(matrix, 0, size - 7);

  // Place timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0;
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0;
  }

  // Place alignment pattern for version >= 2
  if (version >= 2) {
    const positions = getAlignmentPositions(version);
    for (const r of positions) {
      for (const c of positions) {
        if (matrix[r][c] === null) placeAlignment(matrix, r, c);
      }
    }
  }

  // Dark module
  matrix[size - 8][8] = true;

  // Reserve format info area
  for (let i = 0; i < 8; i++) {
    if (matrix[8][i] === null) matrix[8][i] = false;
    if (matrix[i][8] === null) matrix[i][8] = false;
    if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = false;
    if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = false;
  }
  if (matrix[8][8] === null) matrix[8][8] = false;

  // Encode data into remaining cells with simple mask
  const dataBits = encodeDataBits(bytes, version);
  let bitIdx = 0;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // Skip timing column
    for (let count = 0; count < size; count++) {
      const row = ((Math.floor((size - 1 - col) / 2)) % 2 === 0) ? count : size - 1 - count;
      for (let c = 0; c < 2; c++) {
        const actualCol = col - c;
        if (actualCol < 0 || actualCol >= size) continue;
        if (matrix[row][actualCol] === null) {
          const bit = bitIdx < dataBits.length ? dataBits[bitIdx] : false;
          // Apply mask 0 (checkerboard)
          const masked = ((row + actualCol) % 2 === 0) ? !bit : bit;
          matrix[row][actualCol] = masked;
          bitIdx++;
        }
      }
    }
  }

  // Fill any remaining nulls
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === null) matrix[r][c] = false;
    }
  }

  return matrix as boolean[][];
}

function placeFinder(matrix: (boolean | null)[][], row: number, col: number) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const isOn =
        r === 0 || r === 6 || c === 0 || c === 6 ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      matrix[row + r][col + c] = isOn;
    }
  }
  // Separator
  for (let i = -1; i <= 7; i++) {
    setIfValid(matrix, row - 1, col + i, false);
    setIfValid(matrix, row + 7, col + i, false);
    setIfValid(matrix, row + i, col - 1, false);
    setIfValid(matrix, row + i, col + 7, false);
  }
}

function placeAlignment(matrix: (boolean | null)[][], row: number, col: number) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isOn = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      if (row + r >= 0 && col + c >= 0 && row + r < matrix.length && col + c < matrix.length) {
        if (matrix[row + r][col + c] === null) {
          matrix[row + r][col + c] = isOn;
        }
      }
    }
  }
}

function setIfValid(matrix: (boolean | null)[][], r: number, c: number, val: boolean) {
  if (r >= 0 && r < matrix.length && c >= 0 && c < matrix.length && matrix[r][c] === null) {
    matrix[r][c] = val;
  }
}

function getAlignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const last = size - 7;
  if (version <= 6) return [6, last];
  const step = Math.ceil((last - 6) / Math.ceil((version / 7) + 1));
  const positions = [6];
  let pos = last;
  while (pos > 6 + step) {
    positions.unshift(pos);
    pos -= step;
  }
  positions.unshift(6);
  // dedupe
  return [...new Set(positions)].sort((a, b) => a - b);
}

function encodeDataBits(bytes: Uint8Array, version: number): boolean[] {
  const bits: boolean[] = [];

  // Mode indicator: byte mode = 0100
  bits.push(false, true, false, false);

  // Character count (8 bits for version 1-9 byte mode)
  const len = bytes.length;
  for (let i = 7; i >= 0; i--) bits.push(((len >> i) & 1) === 1);

  // Data bytes
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >> i) & 1) === 1);
  }

  // Terminator (up to 4 zeros)
  for (let i = 0; i < 4; i++) bits.push(false);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(false);

  // Pad bytes to fill capacity
  const capacityBits = getCapacityBits(version);
  let padByte = 0;
  while (bits.length < capacityBits) {
    const padVal = padByte % 2 === 0 ? 0xEC : 0x11;
    for (let i = 7; i >= 0; i--) bits.push(((padVal >> i) & 1) === 1);
    padByte++;
  }

  return bits;
}

function getCapacityBits(version: number): number {
  // Approximate data capacity in bits for ECC level L, byte mode
  const caps: Record<number, number> = {
    1: 152, 2: 272, 3: 440, 4: 640, 5: 864, 6: 1088, 7: 1248,
  };
  return caps[version] || 1248;
}

// ── QR Login UI ──

export function renderQrLogin(container: HTMLElement, onSuccess: () => void, onBack: () => void) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let currentToken: string | null = null;

  container.innerHTML = `
    <div class="qr-login-screen">
      <div class="qr-login-card">
        <button class="qr-back-btn" id="qr-back" title="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </button>

        <div class="qr-login-header">
          <h1 class="qr-login-title">Scan to Log In</h1>
          <p class="qr-login-desc">Open RocChat on your phone and scan this code to link your account.</p>
        </div>

        <div class="qr-code-container" id="qr-container">
          <div class="qr-loading">
            <div class="loading-spinner"></div>
            <p>Generating secure code...</p>
          </div>
        </div>

        <div class="qr-login-steps">
          <div class="qr-step">
            <span class="qr-step-num">1</span>
            <span>Open <strong>RocChat</strong> on your phone</span>
          </div>
          <div class="qr-step">
            <span class="qr-step-num">2</span>
            <span>Go to <strong>Settings → Linked Devices</strong></span>
          </div>
          <div class="qr-step">
            <span class="qr-step-num">3</span>
            <span>Tap <strong>"Scan QR Code"</strong> and point at this code</span>
          </div>
        </div>

        <div class="qr-login-divider">
          <span>or</span>
        </div>

        <div class="qr-login-fallback">
          <a id="manual-login-link" class="qr-fallback-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            Sign in with passphrase
          </a>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#qr-back')?.addEventListener('click', () => {
    cleanup();
    onBack();
  });

  container.querySelector('#manual-login-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    cleanup();
    // Switch to manual auth mode
    import('../auth/auth.js').then(({ renderAuth }) => {
      renderAuth(container, onSuccess);
    });
  });

  startQrSession();

  async function startQrSession() {
    const qrContainer = document.getElementById('qr-container');
    if (!qrContainer) return;

    try {
      const res = await api.generateQrToken();
      if (!res.ok) {
        qrContainer.innerHTML = '<p class="qr-error">Failed to generate QR code. Please refresh.</p>';
        return;
      }

      currentToken = res.data.token;
      const qrData = `rocchat://web-login?token=${currentToken}`;
      const qrSvg = generateQRCodeSVG(qrData, 240);

      qrContainer.innerHTML = `
        <div class="qr-code">${qrSvg}</div>
        <div class="qr-status" id="qr-status">
          <span class="qr-status-dot"></span>
          Waiting for scan...
        </div>
      `;

      // Start polling
      pollTimer = setInterval(pollForAuth, 2000);

      // Auto-expire after 5 minutes
      setTimeout(() => {
        if (pollTimer) {
          clearInterval(pollTimer);
          const status = document.getElementById('qr-status');
          if (status) status.textContent = 'QR code expired.';
          qrContainer.innerHTML += `
            <button class="btn-primary qr-refresh-btn" id="qr-refresh">Generate New Code</button>
          `;
          document.getElementById('qr-refresh')?.addEventListener('click', () => {
            startQrSession();
          });
        }
      }, 300_000);
    } catch {
      if (qrContainer) {
        qrContainer.innerHTML = '<p class="qr-error">Connection error. Please refresh.</p>';
      }
    }
  }

  async function pollForAuth() {
    if (!currentToken) return;
    try {
      const res = await api.pollQrToken(currentToken);
      if (!res.ok) return;

      const status = document.getElementById('qr-status');

      if (res.data.status === 'authorized') {
        cleanup();
        // Store session
        api.setToken(res.data.session_token!);
        localStorage.setItem('rocchat_user_id', res.data.user_id!);
        if (res.data.encrypted_keys) {
          localStorage.setItem('rocchat_keys', res.data.encrypted_keys);
        }
        if (res.data.identity_key) {
          localStorage.setItem('rocchat_identity_pub', res.data.identity_key);
        }
        if (status) {
          status.textContent = 'Authenticated!';
          status.classList.add('qr-status-success');
        }
        setTimeout(onSuccess, 500);
      } else if (res.data.status === 'expired') {
        cleanup();
        if (status) status.textContent = 'QR code expired.';
      }
    } catch {
      // Network error — keep polling
    }
  }

  function cleanup() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
}
