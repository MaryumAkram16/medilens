import { Retell } from 'retell-sdk';

/** The only fields of Retell's create-web-call response the browser needs to join. */
export const WEB_CALL_FIELDS = ['call_id', 'access_token'] as const;

export type CreateWebCall = (agentId: string) => Promise<{ call_id: string; access_token: string }>;

/**
 * Asks Retell for a browser call. The API key never leaves the server; the
 * browser only gets a short-lived access token for this one call.
 */
export function retellWebCall(apiKey: string): CreateWebCall {
  return async (agentId) => {
    const client = new Retell({ apiKey, timeout: 8_000, maxRetries: 1 });
    const call = (await client.call.createWebCall({ agent_id: agentId })) as unknown as Record<string, unknown>;
    if (typeof call.call_id !== 'string' || typeof call.access_token !== 'string') throw new Error('retell_bad_response');
    return { call_id: call.call_id, access_token: call.access_token };
  };
}
