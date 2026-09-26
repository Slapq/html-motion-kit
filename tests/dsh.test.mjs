import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as plugin from '../dsh/index.js';

// Minimal stand-in for the DSH plugin context: records registrations and runs effects.
function mockCtx() {
  const ctx = { tools: [], skills: [], disposers: [] };
  ctx.effect = (fn) => { const d = fn(); if (d) ctx.disposers.push(d); };
  ctx.tools.register = (t) => { ctx.tools.push(t); return () => ctx.tools.splice(ctx.tools.indexOf(t), 1); };
  ctx.skills.register = (s) => { ctx.skills.push(s); return () => ctx.skills.splice(ctx.skills.indexOf(s), 1); };
  return ctx;
}

test('apply registers skill and tools once, disposers unregister', () => {
  globalThis.__dshMountOnce?.delete(plugin.name);
  const ctx = mockCtx();
  plugin.apply(ctx, {});
  plugin.apply(ctx, {});
  assert.deepEqual(ctx.tools.map((t) => t.name), ['motion_info', 'motion_new', 'motion_still', 'motion_render']);
  assert.equal(ctx.skills.length, 1);
  assert.deepEqual(plugin.inject, ['tools', 'skills']);
  for (const d of ctx.disposers) d();
  assert.equal(ctx.tools.length, 0);
  assert.equal(ctx.skills.length, 0);
});

test('rejects a root that is not the kit', () => {
  assert.throws(() => plugin.resolveConfig({ root: '/' }), /不是 HTML Motion Kit/);
});

const tools = Object.fromEntries(plugin.makeTools(plugin.resolveConfig()).map((t) => [t.name, t]));

test('motion_info lists projects', async () => {
  const r = await tools.motion_info.execute({});
  assert.ok(r.ok);
  assert.ok(r.projects.includes('graph-showcase'));
});

test('path and argument validation', async () => {
  for (const project of ['../x', 'a/b', '', 'no-such-project']) {
    const r = await tools.motion_still.execute({ project, t: 1 });
    assert.equal(r.ok, false, project);
  }
  assert.equal((await tools.motion_render.execute({ project: 'demo', out: '../escape.mp4' })).ok, false);
  assert.equal((await tools.motion_render.execute({ project: 'demo', out: 'x.mov' })).ok, false);
  assert.equal((await tools.motion_render.execute({ project: 'demo', workers: -1 })).ok, false);
  assert.equal((await tools.motion_still.execute({ project: 'demo', t: -1 })).ok, false);
  assert.equal((await tools.motion_new.execute({ name: '../evil' })).ok, false);
});

test('motion_still renders a PNG with props', { timeout: 120000 }, async () => {
  const r = await tools.motion_still.execute({ project: 'graph-showcase', t: 44, props: { title: 'DSH' } });
  assert.ok(r.ok, r.message);
  assert.ok(existsSync(r.path));
  const buf = await fs.readFile(r.path);
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  await fs.unlink(r.path);
});
