import { handlerFor } from '../lib/http.js';

const handler = handlerFor('submitComplaint');

// Every method goes to the handler so it, not the platform, answers wrong
// methods and CORS preflights with consistent headers.
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS };
