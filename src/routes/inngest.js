// Inngest serve endpoint (production). Inngest Cloud calls this URL to run
// registered functions. Harmless when Inngest is not configured.
import { serve } from 'inngest/express';
import { inngest, inngestFunctions } from '../lib/events.js';
import '../inngest/index.js'; // ensure all workflows are registered before serving
import { config } from '../config.js';

const handler = serve({
  client: inngest,
  functions: inngestFunctions,
  signingKey: config.inngest.signingKey || undefined,
});

export default handler;
