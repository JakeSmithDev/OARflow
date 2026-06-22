// Token-guarded file access (local driver). S3 files are served via presigned
// URLs directly, so this mainly backs the dev/local driver.
import express from 'express';
import { asyncHandler, notFound, toInt } from '../lib/http.js';
import { getFileByToken, readLocal, signedUrl } from '../lib/storage.js';

const router = express.Router();

router.get('/:id', asyncHandler(async (req, res) => {
  const file = await getFileByToken(toInt(req.params.id), String(req.query.token || ''));
  if (!file) return notFound(res, 'File not found.');
  if (file.storage_driver === 's3') return res.redirect(await signedUrl(file));
  try {
    res.set('Content-Type', file.content_type || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(readLocal(file));
  } catch { return notFound(res, 'File not found.'); }
}));

export default router;
