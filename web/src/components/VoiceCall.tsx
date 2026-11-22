import { useEffect, useRef, useState } from 'react';
import { ApiError, callSummary as fetchSummary, createWebCall as apiCreateWebCall, type CallSummary } from '../api';
import { toLines, transcriptText, type Line } from '../lib';
import { CopyButton } from './CopyButton';

/** The parts of Retell's web client this page uses (injectable for tests). */
export interface CallClient {
  startCall(config: { accessToken: string }): Promise<void>;
  stopCall(): void;
  mute(): void;
  unmute(): void;
  on(event: string, fn: (...args: never[]) => void): unknown;
  removeAllListeners(): unknown;
}

const loadRetell = async (): Promise<CallClient> => {
  const { RetellWebClient } = await import('retell-client-js-sdk');
  return new RetellWebClient() as unknown as CallClient;
};

type Phase = 'idle' | 'passcode' | 'connecting' | 'live' | 'ended' | 'error';

export interface VoiceCallProps {
  createCall?: typeof apiCreateWebCall;
  loadClient?: () => Promise<CallClient>;
  getSummary?: typeof fetchSummary;
}

export function VoiceCall({ createCall = apiCreateWebCall, loadClient = loadRetell, getSummary = fetchSummary }: VoiceCallProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [passcode, setPasscode] = useState('');
  const [muted, setMuted] = useState(false);
  const [agentTalking, setAgentTalking] = useState(false);
  const [summary, setSummary] = useState<CallSummary | null>(null);
  const client = useRef<CallClient | null>(null);
  const ids = useRef<{ callId: string; token: string } | null>(null);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  useEffect(
    () => () => {
      // Leaving the page: detach first so the hang-up doesn't update a component that's gone.
      client.current?.removeAllListeners();
      client.current?.stopCall();
    },
    [],
  );
  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and an effect
  // that returns anything but a cleanup function crashes React (white page).
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [lines]);

  async function loadSummary() {
    if (!ids.current) return;
    try {
      setSummary(await getSummary(ids.current.callId, ids.current.token));
    } catch {
      setSummary(null);
    }
  }

  async function start(code?: string) {
    setError(null);
    setLines([]);
    setSummary(null);
    setPhase('connecting');
    let call;
    try {
      call = await createCall(code);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASSCODE_REQUIRED') {
        setPhase('passcode');
        setError(code ? 'That demo code is not right.' : null);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't start the call.");
      setPhase('error');
      return;
    }
    ids.current = { callId: call.call_id, token: call.summary_token };
    try {
      const c = await loadClient();
      client.current = c;
      c.on('call_started', () => setPhase('live'));
      c.on('update', ((u: { transcript?: unknown[] }) => setLines(toLines(u.transcript ?? []))) as never);
      c.on('agent_start_talking', () => setAgentTalking(true));
      c.on('agent_stop_talking', () => setAgentTalking(false));
      c.on('call_ended', () => {
        setPhase('ended');
        setAgentTalking(false);
        c.removeAllListeners();
        // The tools log what they did during the call, so the summary is ready now.
        void loadSummary();
      });
      c.on('error', () => {
        setError('The call dropped. Please try again.');
        setPhase('error');
        c.stopCall();
      });
      await c.startCall({ accessToken: call.access_token });
    } catch {
      setError('Microphone or connection problem. Allow the microphone and try again.');
      setPhase('error');
    }
  }

  function end() {
    client.current?.stopCall();
  }

  function toggleMute() {
    if (!client.current) return;
    if (muted) client.current.unmute();
    else client.current.mute();
    setMuted(!muted);
  }

  const inCall = phase === 'connecting' || phase === 'live';

  return (
    <div className="voice">
      {phase === 'passcode' ? (
        <form
          className="passcode"
          onSubmit={(e) => {
            e.preventDefault();
            void start(passcode.trim());
          }}
        >
          <label htmlFor="passcode">This demo needs a code</label>
          <div className="row">
            <input id="passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Demo code" autoComplete="off" />
            <button className="btn" type="submit" disabled={!passcode.trim()}>
              Start call
            </button>
          </div>
        </form>
      ) : (
        <>
          <button
            className={`call-button ${inCall ? 'in-call' : ''} ${agentTalking ? 'talking' : ''}`}
            onClick={() => (inCall ? end() : void start())}
            aria-label={inCall ? 'End call' : 'Call the MediLens agent'}
          >
            <PhoneIcon off={inCall} />
          </button>
          <p className="call-label">
            {phase === 'connecting' ? 'CONNECTING…' : phase === 'live' ? (agentTalking ? 'AGENT IS SPEAKING' : 'LISTENING · TAP TO END') : 'TAP TO CALL AGENT'}
          </p>
          {phase === 'live' && (
            <button className="link" onClick={toggleMute}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
          )}
        </>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {(inCall || phase === 'ended') && (
        <section className="transcript" aria-live="polite" aria-label="Live transcript">
          <div className="transcript-head">
            <h3>{phase === 'ended' ? 'Transcript' : 'Live transcript'}</h3>
            {lines.length > 0 && (
              <CopyButton
                label="📋 Copy transcript"
                text={transcriptText(lines, summary ? (summary.actions.length ? summary.actions.map((a) => `• ${a.text}`).join('\n') : summary.text) : undefined)}
              />
            )}
          </div>
          {lines.length === 0 ? (
            <p className="muted">The conversation will appear here as you talk.</p>
          ) : (
            lines.map((l, i) => (
              <p key={i} className={`line ${l.speaker}`}>
                <span>{l.speaker === 'you' ? 'You' : 'MediLens'}</span>
                {l.text}
              </p>
            ))
          )}
          <div ref={transcriptEnd} />
        </section>
      )}

      {phase === 'ended' && (
        <section className="summary card" aria-label="Call summary">
          <h3>Call summary</h3>
          {summary ? (
            summary.actions.length ? (
              <ul>
                {summary.actions.map((a, i) => (
                  <li key={i}>{a.text}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">{summary.text}</p>
            )
          ) : (
            <p className="muted">Nothing to summarise yet.</p>
          )}
          <p className="muted small">If you gave an email during the call, this summary is emailed to you too.</p>
        </section>
      )}
    </div>
  );
}

function PhoneIcon({ off }: { off: boolean }) {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path
        d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"
        transform={off ? 'rotate(135 12 12)' : undefined}
      />
    </svg>
  );
}
