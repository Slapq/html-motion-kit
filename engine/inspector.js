// Inspector panel (preview only, never in export). Toggle with the "I" key.
// - Tracks: every animated target / prop, with source trace (op:… / node:… / preset:…) and a curve plot.
// - Graph: every node and its params; numeric values are live-editable (g.set), re-rendered instantly.
// - Export JSON: full timeline trace + graphs (copied to clipboard and logged).
export function mountInspector(player, stage) {
  const tl = player.tl;
  const box = document.createElement('aside');
  box.className = 'inspector';
  box.hidden = true;
  box.setAttribute('aria-label', '检查器');
  box.innerHTML = `
    <header><b>Inspector</b><span class="hint">I 切换</span>
      <button class="json" type="button">导出 JSON</button></header>
    <nav><button type="button" data-tab="tracks" aria-pressed="true">轨道</button><button type="button" data-tab="graph" aria-pressed="false">节点图</button><button type="button" data-tab="ops" aria-pressed="false">算子</button></nav>
    <input class="filter" type="search" placeholder="过滤…" aria-label="过滤">
    <canvas class="curve" width="560" height="140" aria-label="属性曲线"></canvas>
    <div class="list" role="tree"></div>`;
  document.body.appendChild(box);
  const list = box.querySelector('.list'), cv = box.querySelector('.curve'), g = cv.getContext('2d'), filter = box.querySelector('.filter');
  let tab = 'tracks', sel = null;
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function drawCurve() {
    g.clearRect(0, 0, cv.width, cv.height);
    if (!sel) { g.fillStyle = '#777'; g.font = '12px sans-serif'; g.fillText('选择一个属性查看曲线', 12, 22); return; }
    const pts = tl.sample(sel.target, sel.prop, 0, tl.duration, 280).filter(([, v]) => typeof v === 'number');
    if (!pts.length) return;
    let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const X = (t) => (t / tl.duration) * cv.width, Y = (v) => cv.height - 14 - ((v - lo) / (hi - lo)) * (cv.height - 28);
    g.strokeStyle = '#333'; g.beginPath();
    for (const c of tl.chapters || []) { g.moveTo(X(c.start), 0); g.lineTo(X(c.start), cv.height); }
    g.stroke();
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#6ee7ff';
    g.lineWidth = 2; g.beginPath();
    pts.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v))));
    g.stroke(); g.lineWidth = 1;
    const now = player.t, v = tl.valueAt(sel.target, sel.prop, now);
    g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(X(now), 0); g.lineTo(X(now), cv.height); g.stroke();
    g.fillStyle = '#ddd'; g.font = '11px monospace';
    g.fillText(`${sel.name}.${sel.prop} = ${typeof v === 'number' ? v.toFixed(3) : v}   [${lo.toFixed(2)} … ${hi.toFixed(2)}]`, 8, 12);
  }

  function renderTracks(q) {
    for (const [target, tm] of tl.tracks) {
      const name = tl.nameOf(target);
      const mods = tl.mods.get(target) || [];
      const srcs = new Set(mods.map((m) => m.src).filter(Boolean));
      for (const arr of tm.values()) for (const tw of arr) if (tw.src) srcs.add(tw.src);
      if (q && !(name + [...srcs].join(' ')).toLowerCase().includes(q)) continue;
      const row = el('details', 'row');
      const sum = el('summary', null, name);
      if (srcs.size) sum.appendChild(el('small', 'src', [...srcs].join(' · ')));
      row.appendChild(sum);
      const props = new Set([...tm.keys(), ...mods.flatMap((m) => { try { return Object.keys(m(tl.time ?? 0, {}) || {}); } catch { return []; } })]);
      for (const k of props) {
        const b = el('button', 'prop', k);
        b.type = 'button';
        const tws = tm.get(k) || [];
        b.title = tws.map((tw) => `${tw.s.toFixed(2)}→${(tw.s + tw.d).toFixed(2)}s ${tw.ease}${tw.src ? ' · ' + tw.src : ''}`).join('\n') || 'modifier';
        b.onclick = () => { sel = { target, prop: k, name }; drawCurve(); };
        row.appendChild(b);
      }
      list.appendChild(row);
    }
  }

  function renderGraph(q) {
    for (const gr of tl.graphs || []) for (const n of gr.nodes.values()) {
      if (q && !(n.id + n.type).toLowerCase().includes(q)) continue;
      const row = el('details', 'row');
      row.appendChild(el('summary', null, `${n.id}  ⟨${n.type}${n.mode === 'add' ? ' +' : ''}⟩`));
      for (const [k, spec] of Object.entries(n.params || {})) {
        const line = el('label', 'param');
        line.appendChild(el('span', null, k));
        const num = typeof spec === 'number' ? spec : typeof spec?.value === 'number' ? spec.value : null;
        if (num != null) {
          const inp = el('input'); inp.type = 'number'; inp.step = 'any'; inp.value = num;
          inp.oninput = () => {
            const v = parseFloat(inp.value); if (!Number.isFinite(v)) return;
            gr.set(`${n.id}.${k}`, typeof spec === 'number' ? v : Object.assign(n.params[k], { value: v }));
            player.seek(player.t); drawCurve();
          };
          line.appendChild(inp);
        }
        const desc = typeof spec === 'object' ? JSON.stringify(spec, (kk, vv) => (kk === 'value' ? undefined : vv)) : '';
        if (desc && desc !== '{}') line.appendChild(el('code', null, desc));
        const tgt = n._targets?.[0] ?? (() => { try { return gr.resolve(n.target)[0]; } catch { return null; } })();
        if (tgt && n.type !== 'channel') line.onclick = (e) => { if (e.target.tagName !== 'INPUT') { sel = { target: tgt, prop: k, name: tl.nameOf(tgt) }; drawCurve(); } };
        row.appendChild(line);
      }
      list.appendChild(row);
    }
    if (!list.children.length) list.appendChild(el('p', 'empty', '没有节点图。用 tl.graph() 创建。'));
  }

  function renderOps(q) {
    for (const o of tl.ops) {
      if (q && !JSON.stringify(o).toLowerCase().includes(q)) continue;
      const row = el('div', 'row op');
      row.appendChild(el('b', null, o.op));
      row.appendChild(el('small', 'src', `@${(o.at ?? 0).toFixed(2)}s → ${o.target ?? ''}`));
      row.appendChild(el('code', null, JSON.stringify(o.params)));
      list.appendChild(row);
    }
    if (!list.children.length) list.appendChild(el('p', 'empty', '没有算子记录。用 tl.op() 或 graph.op() 调用。'));
  }

  function render() {
    list.textContent = '';
    const q = filter.value.trim().toLowerCase();
    ({ tracks: renderTracks, graph: renderGraph, ops: renderOps })[tab](q);
    drawCurve();
  }

  box.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
    tab = b.dataset.tab;
    box.querySelectorAll('nav button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    render();
  }));
  filter.oninput = render;
  box.querySelector('.json').onclick = async () => {
    const json = JSON.stringify(tl.inspect(), null, 2);
    console.log(json);
    try { await navigator.clipboard.writeText(json); box.querySelector('.json').textContent = '已复制'; } catch { box.querySelector('.json').textContent = '见控制台'; }
    setTimeout(() => (box.querySelector('.json').textContent = '导出 JSON'), 1500);
  };
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyI' || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    box.hidden = !box.hidden;
    if (!box.hidden) render();
  });
  const prev = player.onTime;
  player.onTime = (t) => { prev?.(t); if (!box.hidden) drawCurve(); };
  if (new URLSearchParams(location.search).has('inspect')) { box.hidden = false; render(); }
  return box;
}
