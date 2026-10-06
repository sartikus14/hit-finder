// Small JSON store on Vercel Blob. Everything works without it (no tracking),
// so every call fails soft when the store isn't connected.
let blob = null;
try { blob = require('@vercel/blob'); } catch (e) { blob = null; }

// Works with either connection style Vercel uses: a read-write token, or a store id with Vercel's built-in sign-in (OIDC).
const enabled = () => !!(blob && (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID));
const envInfo = () => ({ package: !!blob, readWriteToken: !!process.env.BLOB_READ_WRITE_TOKEN, storeId: !!process.env.BLOB_STORE_ID });
let access = null; // 'private' or 'public', learned on first success

function order() { return access ? [access] : ['private', 'public']; }

async function readJSON(path) {
  if (!enabled()) return null;
  let lastErr = null;
  for (const a of order()) {
    try {
      const r = await blob.get(path, { access: a, useCache: false });
      if (!r || r.statusCode !== 200) return null;
      access = a;
      const txt = await new Response(r.stream).text();
      return JSON.parse(txt);
    } catch (e) { lastErr = e; }
  }
  if (lastErr && /not.?found/i.test(String(lastErr.message || lastErr))) return null;
  console.error('store read failed', path, lastErr && lastErr.message);
  return null;
}

async function writeJSON(path, data) {
  if (!enabled()) return false;
  let lastErr = null;
  for (const a of order()) {
    try {
      await blob.put(path, JSON.stringify(data), {
        access: a, addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json', cacheControlMaxAge: 60
      });
      access = a;
      return true;
    } catch (e) { lastErr = e; }
  }
  console.error('store write failed', path, lastErr && lastErr.message);
  return false;
}

module.exports = { enabled, envInfo, readJSON, writeJSON };
