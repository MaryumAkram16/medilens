import { handlerFor, type App } from './http.js';
import { ROUTES, routeOf } from './routes.js';

type Handler = (request: Request) => Promise<Response>;

/** One entry point for every endpoint. `pick` is injectable for tests. */
export function createRouter(pick: (name: keyof App) => Handler = handlerFor): Handler {
  const handlers = new Map(Object.entries(ROUTES).map(([route, key]) => [route, pick(key)]));
  return async (request) => {
    const route = routeOf(request);
    const handler = route ? handlers.get(route) : undefined;
    if (!handler) {
      return new Response(JSON.stringify({ success: false, error_code: 'NOT_FOUND', error: 'No such endpoint.' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    return handler(request);
  };
}
