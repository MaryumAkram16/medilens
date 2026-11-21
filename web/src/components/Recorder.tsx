import { useEffect, useRef, useState } from 'react';
import { ApiError, transcribe as apiTranscribe } from '../api';
import { blobToBase64, pickAudioType } from '../lib';

const MAX_SECONDS = 120;

export interface RecorderProps {
  onTranscript: (text: string) => void;
  transcribe?: typeof apiTranscribe;
  getStream?: () => Promise<MediaStream>;
}

type Phase = 'idle' | 'recording' | 'transcribing';

/**
 * Speak your complaint: records with the browser, sends it to /api/transcribe,
 * and hands the text back for the patient to check and edit before submitting.
 * The audio is not stored anywhere.
 */
export function Recorder({ onTranscript, transcribe = apiTranscribe, getStream = () => navigator.mediaDevices.getUserMedia({ audio: true }) }: RecorderProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const supported = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices;
  if (!supported) return null;

  async function start() {
    setError(null);
    const type = pickAudioType();
    if (!type) {
      setError("This browser can't record audio. Please type your complaint.");
      return;
    }
    let media: MediaStream;
    try {
      media = await getStream();
    } catch {
      setError('Microphone access was blocked. Allow it in your browser, or type instead.');
      return;
    }
    const chunks: Blob[] = [];
    stream.current = media;
    const rec = new MediaRecorder(media, { mimeType: type });
    recorder.current = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      media.getTracks().forEach((t) => t.stop());
      stream.current = null;
      if (timer.current) window.clearInterval(timer.current);
      setPhase('transcribing');
      try {
        const blob = new Blob(chunks, { type });
        const result = await transcribe(await blobToBase64(blob), type);
        onTranscript(result.transcript);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't turn that into text. Please try again or type it.");
      } finally {
        setPhase('idle');
      }
    };
    rec.start();
    setSeconds(0);
    setPhase('recording');
    timer.current = window.setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) rec.state === 'recording' && rec.stop();
        return s + 1;
      });
    }, 1000);
  }

  function stop() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }

  return (
    <div className="recorder">
      {phase === 'recording' ? (
        <button type="button" className="btn btn-danger mic" onClick={stop}>
          ■ Stop recording ({seconds}s)
        </button>
      ) : (
        <button type="button" className="btn btn-outline mic" onClick={() => void start()} disabled={phase === 'transcribing'}>
          {phase === 'transcribing' ? 'Turning speech into text…' : '🎤 Speak instead'}
        </button>
      )}
      <span className="muted small">English, Urdu or both. The recording becomes text you can edit; the audio isn't stored.</span>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
