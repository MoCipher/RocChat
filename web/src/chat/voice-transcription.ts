/**
 * RocChat Web — Voice-to-Text (browser Speech Recognition)
 *
 * Uses the Web Speech API (`SpeechRecognition`) to transcribe the
 * microphone into the message composer. All processing happens on-device
 * in browsers that support it (Chromium-based). No audio leaves the user's
 * machine via this path.
 *
 * Safari / Firefox do not implement this API — we surface a graceful
 * fallback so the mic button simply disables itself.
 */

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isSupported(): boolean {
  return getCtor() !== null;
}

export interface TranscriptionSession {
  stop: () => void;
}

/**
 * Start a live transcription. `onPartial` fires for interim results so the
 * user can see words land as they speak; `onFinal` fires with the full
 * punctuated transcript when the engine detects a natural pause.
 */
export function start(
  onPartial: (text: string) => void,
  onFinal: (text: string) => void,
  onError?: (message: string) => void,
): TranscriptionSession | null {
  const Ctor = getCtor();
  if (!Ctor) {
    onError?.('Speech recognition not supported in this browser');
    return null;
  }
  const rec = new Ctor();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (ev) => {
    let interim = '';
    let final = '';
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      const transcript = r[0]?.transcript || '';
      if (r.isFinal) final += transcript;
      else interim += transcript;
    }
    if (final) onFinal(final.trim());
    else if (interim) onPartial(interim.trim());
  };
  rec.onerror = () => onError?.('Transcription error');
  rec.onend = () => { /* caller knows via stop() */ };

  try { rec.start(); } catch (e) {
    onError?.(String(e));
    return null;
  }
  return {
    stop: () => { try { rec.stop(); } catch { /* already stopped */ } },
  };
}
