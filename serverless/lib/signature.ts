import { Retell } from 'retell-sdk';

/** Header Retell sets on every custom-function request. */
export const SIGNATURE_HEADER = 'x-retell-signature';

/** `v=<unix ms>,d=<hex HMAC-SHA256>` as produced by retell-sdk. */
const SIGNATURE_FORMAT = /^v=\d{1,16},d=[0-9a-f]{64}$/i;

/**
 * Checks that a request was signed by Retell with our API key. The SDK also
 * rejects signatures older than five minutes, so a captured request can't be
 * replayed later. `rawBody` must be the exact bytes received.
 *
 * The n8n workflow only checked that the header existed; anyone could send one.
 */
export async function verifyRetellSignature(rawBody: string, apiKey: string, signature: string | null): Promise<boolean> {
  if (!signature || !apiKey || !SIGNATURE_FORMAT.test(signature)) return false;
  try {
    return await Retell.verify(rawBody, apiKey, signature);
  } catch {
    return false;
  }
}

/** Signs a body the way Retell does (tests and the smoke script). */
export function signRetellBody(rawBody: string, apiKey: string): Promise<string> {
  return Retell.sign(rawBody, apiKey);
}
