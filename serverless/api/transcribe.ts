import { handlerFor } from '../lib/http.js';

const handler = handlerFor('transcribe');

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS };
