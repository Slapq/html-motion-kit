#!/usr/bin/env node
// GPT Image generation via an OpenAI-compatible gateway.
//
// Env:  OPENAI_API_KEY (required)   OPENAI_BASE_URL (default https://api.openai.com/v1)
//       IMAGE_MODEL (default gpt-image-2.5-sunburst)
//
// Single image:
//   node tools/gen-image.mjs --prompt "..." --out projects/demo/assets/hero.png [--size 1536x1024]
//        [--quality high] [--transparent] [--model gpt-image-2.5-flare]
// Edit / derive from reference images (character parts, variants):
//   node tools/gen-image.mjs --edit ref.png [--edit ref2.png] [--mask m.png] --prompt "..." --out x.png
// Batch from a manifest (skips files that already exist unless --force):
//   node tools/gen-image.mjs --manifest projects/demo/assets.json
//   manifest: { "defaults": {size,quality,...}, "images": [ { "out": "assets/bg.png", "prompt": "...", "edit": ["assets/char.png"] } ] }
//   Paths in a manifest are relative to the manifest file.
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = { edit: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  if (k === 'edit') opt.edit.push(v);
  else opt[k] = v;
}

const BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.IMAGE_MODEL || 'gpt-image-2.5-sunburst';

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function generate(job) {
  const model = job.model || MODEL;
  const body = {
    model,
    prompt: job.prompt,
    size: job.size || '1536x1024',
    quality: job.quality || 'high',
    n: 1,
  };
  const ext = path.extname(job.out).slice(1).toLowerCase();
  if (['png', 'webp', 'jpeg'].includes(ext)) body.output_format = ext;
  if (ext === 'jpg') body.output_format = 'jpeg';
  if (job.transparent) {
    if (body.output_format === 'jpeg') throw new Error(`${job.out}: transparent requires .png or .webp`);
    body.background = 'transparent';
  }

  let res;
  const edits = (job.edit || []).filter(Boolean);
  if (edits.length) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) fd.append(k, String(v));
    for (const p of edits) {
      const buf = await fs.readFile(p);
      fd.append(edits.length > 1 ? 'image[]' : 'image', new Blob([buf], { type: mime(p) }), path.basename(p));
    }
    if (job.mask) fd.append('mask', new Blob([await fs.readFile(job.mask)], { type: 'image/png' }), 'mask.png');
    res = await fetch(`${BASE}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd });
  } else {
    res = await fetch(`${BASE}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${job.out}: HTTP ${res.status} ${text.slice(0, 400)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${job.out}: non-JSON response ${text.slice(0, 200)}`); }
  const d = json.data?.[0];
  let bytes;
  if (d?.b64_json) bytes = Buffer.from(d.b64_json, 'base64');
  else if (d?.url) {
    const r = await fetch(d.url);
    if (!r.ok) throw new Error(`${job.out}: download HTTP ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
  } else throw new Error(`${job.out}: no image in response ${text.slice(0, 200)}`);
  await fs.mkdir(path.dirname(job.out), { recursive: true });
  await fs.writeFile(job.out, bytes);
  // Keep the prompt next to the image so assets can be regenerated/audited.
  await fs.writeFile(job.out + '.prompt.json', JSON.stringify({ model, ...body, edit: edits, mask: job.mask, usage: json.usage }, null, 2));
  console.log(`✓ ${job.out} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

const mime = (p) => ({ '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(p).toLowerCase()] || 'application/octet-stream';

async function main() {
  if (!KEY) { console.error('OPENAI_API_KEY is not set'); process.exit(2); }
  let jobs;
  if (opt.manifest) {
    const dir = path.dirname(path.resolve(opt.manifest));
    const m = JSON.parse(await fs.readFile(opt.manifest, 'utf8'));
    const rel = (p) => (p ? path.resolve(dir, p) : p);
    jobs = m.images.map((j) => ({
      ...m.defaults, ...j,
      out: rel(j.out),
      edit: [].concat(j.edit || []).map(rel),
      mask: rel(j.mask),
    }));
  } else {
    if (!opt.prompt || !opt.out) { console.error('need --prompt and --out (or --manifest)'); process.exit(2); }
    jobs = [{ ...opt, transparent: !!opt.transparent }];
  }
  // Jobs that depend on another job's output (via edit) must wait for it: run in
  // dependency waves, parallel inside a wave.
  const conc = +(opt.concurrency || 3);
  const pending = [];
  for (const j of jobs) {
    if (!opt.force && (await exists(j.out))) { console.log(`· skip ${path.relative(process.cwd(), j.out)} (exists)`); continue; }
    pending.push(j);
  }
  const outs = new Set(pending.map((j) => j.out));
  const done = new Set();
  let failed = 0;
  while (pending.length) {
    const wave = pending.filter((j) => j.edit.every((e) => !outs.has(e) || done.has(e)));
    if (!wave.length) throw new Error('circular edit dependencies in manifest');
    for (let i = 0; i < wave.length; i += conc) {
      await Promise.all(wave.slice(i, i + conc).map((j) => generate(j).then(
        () => done.add(j.out),
        (e) => { failed++; console.error('✗', e.message); outs.delete(j.out); },
      )));
    }
    for (const j of wave) pending.splice(pending.indexOf(j), 1);
  }
  if (failed) { console.error(`${failed} image(s) failed`); process.exit(1); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
