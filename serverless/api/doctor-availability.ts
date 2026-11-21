import { handlerFor } from '../lib/http.js';

// Retell voice agent tool. Requests must carry a valid x-retell-signature.
const handler = handlerFor('doctorAvailability');

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS };
