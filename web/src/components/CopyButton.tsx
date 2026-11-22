import { useEffect, useState } from 'react';
import { copyText } from '../lib';

/** A small button that copies text and briefly says so. */
export function CopyButton({ text, label, copy = copyText }: { text: string; label: string; copy?: typeof copyText }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button type="button" className="btn btn-outline btn-small copy" onClick={async () => setState((await copy(text)) ? 'copied' : 'failed')}>
      {state === 'copied' ? '✓ Copied' : state === 'failed' ? 'Select the text to copy' : label}
    </button>
  );
}
