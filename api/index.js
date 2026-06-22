// Vercel serverless entry. The Express app is itself a (req, res) handler, so
// Vercel's Node runtime can invoke it directly. vercel.json routes every path
// here, and Express does the rest (static + APIs).
import { createApp } from '../src/app.js';

const app = createApp();
export default app;
