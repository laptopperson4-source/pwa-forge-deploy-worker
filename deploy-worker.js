/**
 * PWA Forge — Deploy Worker (v3: Workers static-assets, officially documented)
 * -----------------------------------------------------------------------------
 * Receives generated PWA files from the Forge tool and publishes them as a
 * Cloudflare Worker with static assets, returning a live *.workers.dev URL.
 *
 * This replaces two earlier approaches that both failed in ways that only
 * showed up after reporting success:
 *   v1 — Pages' internal direct-upload sequence (reverse-engineered from a
 *        blog post). Hash format was wrong; later fixed, but deployments
 *        still silently failed to actually serve their uploaded bytes.
 *   v2 — Pages projects Git-connected to a freshly-created GitHub repo.
 *        Hit a real Cloudflare-side bug where project creation reports
 *        success while never actually attaching the GitHub source.
 *   v3 (this version) — Cloudflare's officially documented Workers static
 *        assets direct-upload flow: https://developers.cloudflare.com/workers/static-assets/direct-upload/
 *        Every endpoint here is long-stable/documented, and the hash
 *        formula (sha256(base64(bytes) + ext).slice(0,32), used as-is,
 *        no suffix) is taken directly from Cloudflare's own reference
 *        implementation rather than guessed.
 *
 * SETUP (no CLI needed — paste this whole file into the Cloudflare dashboard):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Workers → Create Worker
 *   2. Name it (e.g. "pwa-forge-deploy") → Deploy
 *   3. Edit code → delete the placeholder → paste this entire file → Save & Deploy
 *   4. Go to the Worker's Settings → Variables and Secrets → Add:
 *        CF_API_TOKEN   (Secret)  = a token with Workers Scripts:Edit permission
 *        CF_ACCOUNT_ID  (Secret)  = your Cloudflare account ID
 *   5. Copy the Worker's URL (shown at the top, ends in .workers.dev) and
 *      send it back — that's the only thing that goes into the Forge page.
 *
 * NOTE: the CF_API_TOKEN needs "Workers Scripts: Edit" permission (not just
 * "Pages: Edit" from earlier versions) — if deploys start failing with an
 * auth/permission error after upgrading to this version, that's why.
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

    if (url.pathname === '/generate-icon' && request.method === 'POST') {
      return handleGenerateIcon(request, env, cors);
    }

    if (url.pathname.startsWith('/debug/') && request.method === 'GET') {
      return handleDebug(url.pathname.slice('/debug/'.length), env, cors);
    }

    if (url.pathname !== '/deploy' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST /deploy, POST /generate-icon, or GET /debug/<project-slug>' }), {
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

      // 1. Build the manifest using Cloudflare's documented formula:
      //    hash = sha256( base64(fileBytes) + extensionWithoutDot ), first 32 hex chars.
      //    (Confirmed against Cloudflare's own reference implementation —
      //    this differs from what earlier versions of this Worker guessed.)
      const manifest = {};
      const contentByHash = {};
      for (const [rawPath, b64] of Object.entries(files)) {
        const path = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
        const ext = (path.match(/\.([a-zA-Z0-9]+)$/) || ['', ''])[1];
        const hash = (await sha256HexOfString(b64 + ext)).slice(0, 32);
        const bytes = base64ToBytes(b64);
        manifest[path] = { hash, size: bytes.length };
        contentByHash[hash] = { b64, contentType: contentTypeFor(path) };
      }

      // 2. Open an asset upload session
      const sessionRes = await fetch(`${API}/accounts/${acct}/workers/scripts/${slug}/assets-upload-session`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ manifest })
      });
      const sessionText = await sessionRes.text();
      let sessionData; try { sessionData = JSON.parse(sessionText); } catch (e) {}
      if (!sessionRes.ok || !sessionData || !sessionData.success) {
        throw new Error('Could not open asset upload session: ' + sessionText);
      }

      let completionJwt = sessionData.result.jwt;
      const buckets = sessionData.result.buckets || [];

      // 3. Upload each bucket of (new/changed) files as multipart/form-data —
      // every file part carries its real Content-Type so it serves correctly.
      for (const bucket of buckets) {
        const form = new FormData();
        for (const hash of bucket) {
          const entry = contentByHash[hash];
          if (!entry) throw new Error('Upload session asked for a hash we did not send: ' + hash);
          form.append(hash, new Blob([entry.b64], { type: entry.contentType }), hash);
        }
        const upRes = await fetch(`${API}/accounts/${acct}/workers/assets/upload?base64=true`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${completionJwt}` },
          body: form
        });
        const upText = await upRes.text();
        let upData; try { upData = JSON.parse(upText); } catch (e) {}
        if (!upRes.ok || !upData || !upData.success) {
          throw new Error('Asset bucket upload failed: ' + upText);
        }
        if (upData.result && upData.result.jwt) completionJwt = upData.result.jwt;
      }

      // 4. Deploy the script: a tiny router that always serves from the
      // ASSETS binding, plus the completion JWT that finalizes the assets
      // we just uploaded.
      const workerScript = `export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };`;
      const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2026-07-25',
        assets: { jwt: completionJwt, config: { html_handling: 'auto-trailing-slash' } },
        bindings: [{ type: 'assets', name: 'ASSETS' }]
      };
      const deployForm = new FormData();
      deployForm.append('metadata', JSON.stringify(metadata));
      deployForm.append('worker.js', new Blob([workerScript], { type: 'application/javascript+module' }), 'worker.js');

      const putRes = await fetch(`${API}/accounts/${acct}/workers/scripts/${slug}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
        body: deployForm
      });
      const putText = await putRes.text();
      let putData; try { putData = JSON.parse(putText); } catch (e) {}
      if (!putRes.ok || !putData || !putData.success) {
        throw new Error('Script deployment failed: ' + putText);
      }

      // 5. Make sure it's reachable on the account's workers.dev subdomain
      const subRes = await fetch(`${API}/accounts/${acct}/workers/scripts/${slug}/subdomain`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ enabled: true })
      });
      if (!subRes.ok) {
        throw new Error('Deployed, but could not enable workers.dev route: ' + await subRes.text());
      }

      // 6. Get the account's workers.dev subdomain to build the final URL
      const subdomainRes = await fetch(`${API}/accounts/${acct}/workers/subdomain`, { headers: authHeaders });
      const subdomainData = await subdomainRes.json();
      const accountSubdomain = subdomainData.result && subdomainData.result.subdomain;
      if (!accountSubdomain) throw new Error('Deployed, but could not determine the workers.dev subdomain to build the URL.');

      const liveUrl = `https://${slug}.${accountSubdomain}.workers.dev`;
      return new Response(JSON.stringify({
        url: liveUrl,
        debug: { filesInManifest: Object.keys(manifest).length, bucketsUploaded: buckets.length }
      }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || String(err) }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};

function extractSlug(raw) {
  let s = decodeURIComponent(raw || '');
  const m = s.match(/([a-z0-9-]+)\.pages\.dev/i);
  if (m) return m[1].toLowerCase();
  s = s.replace(/^https?:\/\//i, '').split('/')[0];
  return s.replace(/[^a-z0-9-]/gi, '').toLowerCase();
}

async function handleDebug(rawSlug, env, cors) {
  try {
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new Error('Worker is missing CF_API_TOKEN / CF_ACCOUNT_ID secrets');
    const slug = extractSlug(rawSlug);
    if (!slug) throw new Error('Visit /debug/<script-slug> — e.g. /debug/ytshorts-yaik6 (a full pasted URL also works too)');

    const headers = { 'Authorization': `Bearer ${env.CF_API_TOKEN}` };
    const acct = env.CF_ACCOUNT_ID;

    const listRes = await fetch(`${API}/accounts/${acct}/workers/scripts`, { headers });
    const listData = await listRes.json();
    const scriptEntry = listData.result && listData.result.find(s => s.id === slug);

    const subRes = await fetch(`${API}/accounts/${acct}/workers/scripts/${slug}/subdomain`, { headers });
    const subData = await subRes.json();

    const acctSubRes = await fetch(`${API}/accounts/${acct}/workers/subdomain`, { headers });
    const acctSubData = await acctSubRes.json();

    return new Response(renderDebugHtml(slug, scriptEntry, listData, subData, acctSubData), {
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' }
    });
  } catch (err) {
    return new Response('<pre>Debug error: ' + escapeHtmlDbg(err.message || String(err)) + '</pre>', {
      status: 500, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

function renderDebugHtml(slug, scriptEntry, listData, subData, acctSubData) {
  const accountSubdomain = acctSubData.result && acctSubData.result.subdomain;
  const liveUrl = accountSubdomain ? `https://${slug}.${accountSubdomain}.workers.dev` : null;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debug: ${escapeHtmlDbg(slug)}</title>
<style>
  body{font-family:ui-monospace,monospace;background:#0a0a10;color:#eee;padding:16px;font-size:13px;line-height:1.6;}
  h2{color:#8B5CF6;} h3{color:#22D3EE;margin-top:24px;}
  pre{white-space:pre-wrap;word-break:break-all;background:#1a1a24;padding:12px;border-radius:8px;font-size:11px;}
  .field{margin:4px 0;} .k{color:#9A9AB0;}
  a{color:#22D3EE;}
</style></head><body>
<h2>Script: ${escapeHtmlDbg(slug)}</h2>
<div class="field"><span class="k">Exists:</span> ${scriptEntry ? 'yes' : 'NO — not found in this account\'s script list'}</div>
<div class="field"><span class="k">Modified:</span> ${escapeHtmlDbg(scriptEntry && scriptEntry.modified_on)}</div>
<div class="field"><span class="k">Account subdomain:</span> ${escapeHtmlDbg(accountSubdomain || 'not found')}</div>
<div class="field"><span class="k">Expected live URL:</span> ${liveUrl ? `<a href="${liveUrl}">${escapeHtmlDbg(liveUrl)}</a>` : 'unknown'}</div>
<div class="field"><span class="k">workers.dev route enabled:</span> ${escapeHtmlDbg(JSON.stringify(subData.result))}</div>

<h3>Raw script list entry</h3>
<pre>${escapeHtmlDbg(JSON.stringify(scriptEntry, null, 2))}</pre>
<h3>Raw subdomain-route response</h3>
<pre>${escapeHtmlDbg(JSON.stringify(subData, null, 2))}</pre>
<h3>Raw account subdomain response</h3>
<pre>${escapeHtmlDbg(JSON.stringify(acctSubData, null, 2))}</pre>
</body></html>`;
}

function escapeHtmlDbg(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function sha256HexOfString(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
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

async function handleGenerateIcon(request, env, cors) {
  try {
    if (!env.AI) throw new Error('Worker is missing the Workers AI (AI) binding');
    const { prompt } = await request.json();
    if (!prompt || !prompt.trim()) throw new Error('A prompt is required');

    const iconPrompt = `A simple, clean app icon logo of: ${prompt}. Flat vector design, centered composition, bold shapes, solid colors, no text, no watermark, no photorealism, square icon.`;

    const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      prompt: iconPrompt,
      steps: 4
    });

    let base64;
    if (result && typeof result === 'object' && result.image) {
      base64 = result.image; // flux-1-schnell returns { image: base64Jpeg }
    } else if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
      base64 = bufferToBase64(result);
    } else {
      throw new Error('Unexpected response shape from Workers AI');
    }

    return new Response(JSON.stringify({ image: base64 }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

function bufferToBase64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
