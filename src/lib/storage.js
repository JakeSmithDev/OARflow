// File storage. Local-disk driver (dev/demo, zero-setup) or S3-compatible
// (AWS S3 / Cloudflare R2 / MinIO) in production. One interface either way.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { query, queryOne } from './db.js';
import { randomToken } from './crypto.js';

function s3Enabled() {
  const s = config.storage.s3;
  return Boolean(s.bucket && s.accessKeyId && s.secretAccessKey);
}
export function storageDriver() { return s3Enabled() ? 's3' : 'local'; }

function safeName(name) { return String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120); }
function localPath(key) { return path.join(path.resolve(config.storage.localDir), key); }

let _s3 = null;
async function s3Client() {
  if (_s3) return _s3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  const s = config.storage.s3;
  _s3 = new S3Client({
    region: s.region, endpoint: s.endpoint || undefined, forcePathStyle: Boolean(s.endpoint),
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
  return _s3;
}

/** Save bytes and record a files row. Returns the file row. */
export async function saveFile(tenant, { buffer, filename, contentType, ownerType, ownerId, kind, createdBy, meta }) {
  const driver = storageDriver();
  // On serverless (Vercel) the filesystem is ephemeral — refuse to persist to
  // local disk in production where the upload would be silently lost.
  if (driver === 'local' && config.isProduction) {
    throw new Error('Object storage is not configured. Set S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (S3, Cloudflare R2, or MinIO) to store files in production.');
  }
  const key = `tenants/${tenant.id}/${kind || 'file'}/${randomToken(8)}-${safeName(filename)}`;
  if (driver === 's3') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const cli = await s3Client();
    await cli.send(new PutObjectCommand({ Bucket: config.storage.s3.bucket, Key: key, Body: buffer, ContentType: contentType }));
  } else {
    const p = localPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buffer);
  }
  return queryOne(
    `INSERT INTO files (tenant_id, owner_type, owner_id, kind, filename, content_type, size_bytes, storage_driver, storage_key, access_token, meta, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
    [tenant.id, ownerType || null, ownerId || null, kind || null, filename, contentType || null, buffer.length, driver, key, randomToken(), JSON.stringify(meta || {}), createdBy || null],
  );
}

export async function getFile(tenantId, id) {
  return queryOne('SELECT * FROM files WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
}

/** List files for an owner (e.g. an appointment) with browser-fetchable URLs. */
export async function listFiles(tenant, ownerType, ownerId) {
  const r = await query(
    'SELECT * FROM files WHERE tenant_id=$1 AND owner_type=$2 AND owner_id=$3 ORDER BY id DESC',
    [tenant.id, ownerType, ownerId],
  );
  return Promise.all(r.rows.map(async (f) => ({
    id: f.id, kind: f.kind, filename: f.filename, contentType: f.content_type, sizeBytes: Number(f.size_bytes || 0),
    createdAt: f.created_at, createdBy: f.created_by, meta: f.meta, url: await signedUrl(f),
  })));
}
export async function getFileByToken(id, token) {
  const f = await queryOne('SELECT * FROM files WHERE id=$1', [id]);
  return f && f.access_token === token ? f : null;
}

/** A URL the browser can fetch the file from. */
export async function signedUrl(file, { expiresIn = 3600 } = {}) {
  if (file.storage_driver === 's3') {
    if (config.storage.s3.publicBaseUrl) return `${config.storage.s3.publicBaseUrl.replace(/\/$/, '')}/${file.storage_key}`;
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(await s3Client(), new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: file.storage_key }), { expiresIn });
  }
  return `${config.baseUrl}/api/files/${file.id}?token=${file.access_token}`;
}

/** Read bytes for the local driver (used by the local serving route). */
export function readLocal(file) {
  if (file.storage_driver !== 'local') throw new Error('not a local file');
  return fs.readFileSync(localPath(file.storage_key));
}

export async function deleteFile(file) {
  try {
    if (file.storage_driver === 's3') {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await (await s3Client()).send(new DeleteObjectCommand({ Bucket: config.storage.s3.bucket, Key: file.storage_key }));
    } else { fs.rmSync(localPath(file.storage_key), { force: true }); }
  } catch { /* ignore */ }
  await query('DELETE FROM files WHERE id=$1', [file.id]);
}

export default { saveFile, getFile, getFileByToken, listFiles, signedUrl, readLocal, deleteFile, storageDriver };
