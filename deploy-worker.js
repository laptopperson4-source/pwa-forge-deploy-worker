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
      // Cloudflare's asset store expects keys formatted as a 32-char hex
      // digest followed by the file's extension (mirrors what Wrangler
      // produces with blake3) — a bare hash with no suffix breaks routing
      // at serve time even though the upload itself reports success.
      const manifest = {};
      const uploads = [];
      for (const [rawPath, b64] of Object.entries(files)) {
        const path = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
        const bytes = base64ToBytes(b64);
        const digest = await sha256Hex(concatBytes(bytes, new TextEncoder().encode(path)));
        const ext = (path.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
        const hash = digest.slice(0, 32) + ext;
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

      // The response above only confirms the deployment was *queued* — the
      // actual build/publish happens asynchronously afterward and can still
      // fail after this point. Poll until it reaches a real final state
      // instead of trusting success:true on the queue call alone.
      const depId = deployData.result && deployData.result.id;
      let finalStatus = null;
      let finalStage = null;
      if (depId) {
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 2500));
          const checkRes = await fetch(`${API}/accounts/${acct}/pages/projects/${slug}/deployments/${depId}`, { headers: authHeaders });
          const checkData = await checkRes.json();
          const stage = checkData.result && checkData.result.latest_stage;
          finalStage = stage;
          if (stage && stage.status === 'success') { finalStatus = 'success'; break; }
          if (stage && stage.status === 'failure') { finalStatus = 'failure'; break; }
        }
      }
      if (finalStatus === 'failure') {
        throw new Error('Deployment was queued but failed during publish, at stage "' + (finalStage && finalStage.name) + '": ' + JSON.stringify(finalStage));
      }
      if (finalStatus !== 'success') {
        throw new Error('Deployment queued but did not confirm success within 30s. Last known stage: ' + JSON.stringify(finalStage) + '. Check https://' + slug + '.pages.dev in a minute, or view /debug/' + slug + ' for current status.');
      }

      const liveUrl = `https://${slug}.pages.dev`;
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

async function handleDebug(rawSlug, env, cors) {
  try {
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new Error('Worker is missing CF_API_TOKEN / CF_ACCOUNT_ID secrets');
    const slug = rawSlug.replace(/[^a-z0-9-]/gi, '');
    if (!slug) throw new Error('Visit /debug/<project-slug> — e.g. /debug/ytshorts-yaik6');

    const headers = { 'Authorization': `Bearer ${env.CF_API_TOKEN}` };
    const acct = env.CF_ACCOUNT_ID;

    const projRes = await fetch(`${API}/accounts/${acct}/pages/projects/${slug}`, { headers });
    const projData = await projRes.json();

    const depsRes = await fetch(`${API}/accounts/${acct}/pages/projects/${slug}/deployments?per_page=5`, { headers });
    const depsData = await depsRes.json();

    let latestDetail = null;
    if (depsData.result && depsData.result[0]) {
      const depId = depsData.result[0].id;
      const detailRes = await fetch(`${API}/accounts/${acct}/pages/projects/${slug}/deployments/${depId}`, { headers });
      latestDetail = await detailRes.json();
    }

    return new Response(renderDebugHtml(slug, projData, depsData, latestDetail), {
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' }
    });
  } catch (err) {
    return new Response('<pre>Debug error: ' + escapeHtmlDbg(err.message || String(err)) + '</pre>', {
      status: 500, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

function renderDebugHtml(slug, projData, depsData, latestDetail) {
  const proj = projData.result || {};
  const deps = depsData.result || [];
  const latest = latestDetail && latestDetail.result;

  let stagesHtml = '<i>no stage info returned</i>';
  if (latest && latest.stages) {
    stagesHtml = latest.stages.map(s =>
      `<div class="stage ${escapeHtmlDbg(s.status||'')}"><b>${escapeHtmlDbg(s.name)}</b>: ${escapeHtmlDbg(s.status)}${s.ended_on ? ' — ' + escapeHtmlDbg(s.ended_on) : ''}</div>`
    ).join('');
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debug: ${escapeHtmlDbg(slug)}</title>
<style>
  body{font-family:ui-monospace,monospace;background:#0a0a10;color:#eee;padding:16px;font-size:13px;line-height:1.6;}
  h2{color:#8B5CF6;} h3{color:#22D3EE;margin-top:24px;}
  .stage{padding:8px;margin:4px 0;border-radius:6px;background:#1a1a24;}
  .stage.success{border-left:3px solid #34D399;}
  .stage.failure{border-left:3px solid #FB7185;}
  .stage.idle{border-left:3px solid #6A6A7E;}
  .stage.active{border-left:3px solid #F59E0B;}
  pre{white-space:pre-wrap;word-break:break-all;background:#1a1a24;padding:12px;border-radius:8px;font-size:11px;}
  .field{margin:4px 0;} .k{color:#9A9AB0;}
</style></head><body>
<h2>Project: ${escapeHtmlDbg(slug)}</h2>
<div class="field"><span class="k">Exists:</span> ${proj.id ? 'yes' : 'NO — project not found'}</div>
<div class="field"><span class="k">Domains:</span> ${escapeHtmlDbg(JSON.stringify(proj.domains || []))}</div>
<div class="field"><span class="k">Deployments returned:</span> ${deps.length}</div>

<h3>Latest deployment</h3>
${latest ? `
  <div class="field"><span class="k">ID:</span> ${escapeHtmlDbg(latest.id || '')}</div>
  <div class="field"><span class="k">Created:</span> ${escapeHtmlDbg(latest.created_on || '')}</div>
  <div class="field"><span class="k">URL:</span> ${escapeHtmlDbg(latest.url || '')}</div>
  <div class="field"><span class="k">Overall status:</span> ${escapeHtmlDbg((latest.latest_stage && latest.latest_stage.status) || 'unknown')}</div>
  <h3>Stages</h3>
  ${stagesHtml}
` : '<i>No deployment found for this project</i>'}

<h3>Raw project response</h3>
<pre>${escapeHtmlDbg(JSON.stringify(projData, null, 2))}</pre>
<h3>Raw deployments list</h3>
<pre>${escapeHtmlDbg(JSON.stringify(depsData, null, 2))}</pre>
${latestDetail ? `<h3>Raw latest deployment detail</h3><pre>${escapeHtmlDbg(JSON.stringify(latestDetail, null, 2))}</pre>` : ''}
</body></html>`;
}

function escapeHtmlDbg(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

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
