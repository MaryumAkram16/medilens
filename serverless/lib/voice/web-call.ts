import { Retell } from 'retell-sdk';

/** ICE (TURN/STUN) servers Retell hands out per call; short-lived and meant for the browser. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * What the browser needs to join. Retell now issues tokens for one of two
 * media stacks and the tokens look alike, so the client must be told which one:
 * a `gateway` client needs `call_id` and `ice_servers`; a `livekit` client may
 * need `url`. Sending a gateway token down the LiveKit path fails before the
 * microphone is even requested, and Retell records the call as "user not joined".
 */
export interface WebCall {
  call_id: string;
  access_token: string;
  transport: 'gateway' | 'livekit';
  ice_servers?: IceServer[];
  url?: string;
}

export type CreateWebCall = (agentId: string) => Promise<WebCall>;

function iceServers(raw: unknown): IceServer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IceServer[] = [];
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue;
    const { urls, username, credential } = s as Record<string, unknown>;
    const okUrls = typeof urls === 'string' || (Array.isArray(urls) && urls.every((u) => typeof u === 'string'));
    if (!okUrls) continue;
    out.push({
      urls: urls as string | string[],
      ...(typeof username === 'string' ? { username } : {}),
      ...(typeof credential === 'string' ? { credential } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** Picks only the joining fields from Retell's response (nothing else reaches the browser). */
export function toWebCall(call: Record<string, unknown>): WebCall {
  if (typeof call.call_id !== 'string' || typeof call.access_token !== 'string') throw new Error('retell_bad_response');
  // Retell: "treat absent as livekit".
  const transport = call.transport === 'gateway' ? 'gateway' : 'livekit';
  const ice = iceServers(call.ice_servers);
  return {
    call_id: call.call_id,
    access_token: call.access_token,
    transport,
    ...(ice ? { ice_servers: ice } : {}),
    ...(transport === 'livekit' && typeof call.url === 'string' && /^wss:\/\//.test(call.url) ? { url: call.url } : {}),
  };
}

/**
 * Asks Retell for a browser call. The API key never leaves the server; the
 * browser only gets a short-lived access token for this one call.
 */
export function retellWebCall(apiKey: string): CreateWebCall {
  return async (agentId) => {
    const client = new Retell({ apiKey, timeout: 8_000, maxRetries: 1 });
    const call = (await client.call.createWebCall({ agent_id: agentId })) as unknown as Record<string, unknown>;
    return toWebCall(call);
  };
}
