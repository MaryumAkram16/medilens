/** Small browser helpers: live transcript lines, reading aloud, recording, storage. */

export interface Line {
  speaker: 'you' | 'agent';
  text: string;
}

/**
 * Retell's live transcript as lines to show: only what the caller and the agent
 * said (no backchannels like "mm-hmm"), with consecutive turns by the same
 * speaker joined.
 */
export function toLines(utterances: readonly unknown[]): Line[] {
  const lines: Line[] = [];
  for (const u of utterances) {
    if (typeof u !== 'object' || u === null) continue;
    const { role, content, metadata } = u as { role?: unknown; content?: unknown; metadata?: { is_backchannel?: unknown } };
    if (role !== 'agent' && role !== 'user') continue;
    if (metadata?.is_backchannel === true) continue;
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) continue;
    const speaker = role === 'agent' ? 'agent' : 'you';
    const last = lines.at(-1);
    if (last?.speaker === speaker) last.text = `${last.text} ${text}`;
    else lines.push({ speaker, text });
  }
  return lines;
}

/** Reads text aloud with the browser's own voice (free, no key). Returns false if unsupported. */
export function speak(text: string): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Picks a recording format the browser supports and the API accepts. */
export function pickAudioType(isSupported: (t: string) => boolean = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)): string | null {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (isSupported(t)) return t;
  return null;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** sessionStorage that never throws (private windows, blocked storage). */
export const tabStore = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch {
      /* the page still works without it */
    }
  },
};

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' });

/** Copies text to the clipboard; falls back to a hidden textarea where the async API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The transcript as plain text for copying, with the call summary at the end when there is one. */
export function transcriptText(lines: readonly Line[], summary?: string): string {
  const body = lines.map((l) => `${l.speaker === 'you' ? 'You' : 'MediLens'}: ${l.text}`).join('\n');
  return summary ? `${body}\n\nCall summary:\n${summary}` : body;
}
