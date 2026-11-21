import { createRouter } from '../lib/router.js';

// The only function: vercel.json rewrites /api/<route> here (Hobby plan: max 12 functions).
const handler = createRouter();

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS };
