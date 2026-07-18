/**
 * PWA Forge — Deploy Worker
 * -------------------------
 * Receives generated PWA files from the Forge tool and publishes them
 * to Cloudflare Pages, returning a live *.pages.dev URL.
 *
 * SETUP (no CLI needed — paste this whole file into the Cloudflare dashboard):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Workers → Create Worker
 *   2. Name it (e.g. "pwa-forge-deploy") → Deploy
 *   3. Edit code → delete the placeholder → paste this entire file → Save & Deploy
 *   4. Go to the Worker's Settings → Variables and Secrets → Add:
 *        CF_API_TOKEN   (Secret)  = the Pages:Edit token you created
 *        CF_ACCOUNT_ID  (Secret)  = your Cloudflare account ID
 *   5. Copy the Worker's URL (shown at the top, ends in .workers.dev) and
 *      send it back — that's the only thing that goes into the Forge page.
 *
 * This uses Cloudflare's internal direct-upload sequence (the same one
 * Wrangler CLI uses under the hood: upload-token -> assets/upload ->
 * assets/upsert-hashes -> deployments). It's not the officially documented
 * simple endpoint (there isn't one) — if Cloudflare changes these internal
 * routes this may need updating, in which case the manual zip download from
 * Forge always still works as a fallback.
 */

const API = 'https://api.cloudflare.com/client/v4';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== '/deploy' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST /deploy only' }), {
        status: 404, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      return new Response(JSON.stringify({ error: 'Worker is missing CF_API_TOKEN / CF_ACCOUNT_ID secrets' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    try {
      const { projectName, files } = await request.json();
      if (!projectName || !files || typeof files !== 'object') {
        throw new Error('Request must include projectName and a files map');
      }

      const slug = projectName.toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 55) || 'pwa-app';

      const acct = env.CF_ACCOUNT_ID;
      const authHeaders = { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' };

      // 1. Make sure the Pages project exists
      const projCheck = await fetch(`${API}/accounts/${acct}/pages/projects/${slug}`, { headers: authHeaders });
      if (projCheck.status === 404) {
        const created = await fetch(`${API}/accounts/${acct}/pages/projects`, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ name: slug, production_branch: 'main' })
        });
        if (!created.ok) throw new Error('Could not create Pages project: ' + await created.text());
      } else if (!projCheck.ok) {
        throw new Error('Could not reach Pages project: ' + await projCheck.text());
      }

      // 2. Hash every file, build the manifest + upload payload
      const manifest = {};
      const uploads = [];
      for (const [rawPath, b64] of Object.entries(files)) {
        const path = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
        const bytes = base64ToBytes(b64);
        const hash = await sha256Hex(concatBytes(bytes, new TextEncoder().encode(path)));
        manifest[path] = hash;
        uploads.push({ key: hash, value: b64, metadata: { contentType: contentTypeFor(path) }, base64: true });
      }

      // 3. Get a short-lived upload token
      const tokRes = await fetch(`${API}/accounts/${acct}/pages/projects/${slug}/upload-token`, { headers: authHeaders });
      if (!tokRes.ok) throw new Error('Could not get upload token: ' + await tokRes.text());
      const tokData = await tokRes.json();
      const jwt = tokData.result.jwt;

      // 4. Upload assets
      const uploadRes = await fetch(`${API}/pages/assets/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(uploads)
      });
      if (!uploadRes.ok) throw new Error('Asset upload failed: ' + await uploadRes.text());

      // 5. Confirm the hashes
      const upsertRes = await fetch(`${API}/pages/assets/upsert-hashes`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: uploads.map(u => u.key) })
      });
      if (!upsertRes.ok) throw new Error('Hash confirmation failed: ' + await upsertRes.text());

      // 6. Create the deployment
      const form = new FormData();
      form.append('manifest', JSON.stringify(manifest));
      const deployRes = await fetch(`${API}/accounts/${acct}/pages/projects/${slug}/deployments`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
        body: form
      });
      const deployData = await deployRes.json();
      if (!deployRes.ok || !deployData.success) {
        throw new Error('Deployment failed: ' + JSON.stringify(deployData.errors || deployData));
      }

      const liveUrl = (deployData.result && deployData.result.url) || `https://${slug}.pages.dev`;
      return new Response(JSON.stringify({ url: liveUrl }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || String(err) }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function contentTypeFor(path) {
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}
