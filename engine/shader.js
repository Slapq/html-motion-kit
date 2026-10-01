// GPU fragment-shader layer (TouchDesigner GLSL TOP / cables.gl style), frame-exact.
// The shader is a pure function of uniforms, and uniforms are a pure function of time,
// so preview, scrubbing and export all match.
//
//   const sh = new ShaderLayer(el, { frag: `...void main(){ gl_FragColor = vec4(uv, sin(uTime), 1.); }`, uniforms: { uAmp: 1 } });
//   sh.bind(tl);                          // re-renders on every seek
//   tl.to(sh.uniforms, { uAmp: 3 }, ...)  // uniforms are plain numbers / arrays → tweenable, graph-manipulable
//
// Built-in uniforms: uTime (scene-local seconds), uResolution (px). Varying: uv (0..1).
// Uniform types by value: number → float, [a,b] → vec2, [a,b,c] → vec3, [a,b,c,d] → vec4.
const VERT = `attribute vec2 p; varying vec2 uv; void main(){ uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
const HEADER = `precision highp float;\nvarying vec2 uv;\nuniform float uTime;\nuniform vec2 uResolution;\n`;

export class ShaderLayer {
  constructor(parent, { frag, uniforms = {}, width, height, scale = 1, blend, z = 0, className = 'shader-layer' } = {}) {
    const W = width ?? parent.clientWidth ?? 1920, H = height ?? parent.clientHeight ?? 1080;
    const cv = (this.el = document.createElement('canvas'));
    cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
    cv.className = className;
    Object.assign(cv.style, { position: 'absolute', left: 0, top: 0, width: W + 'px', height: H + 'px', zIndex: z, pointerEvents: 'none' });
    if (blend) cv.style.mixBlendMode = blend;
    parent.appendChild(cv);
    this.uniforms = { ...uniforms };
    this.name = 'shader';
    const gl = (this.gl = cv.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false }));
    if (!gl) throw new Error('ShaderLayer: WebGL unavailable');
    const decl = Object.entries(this.uniforms).map(([k, v]) => `uniform ${typeOf(v)} ${k};`).join('\n');
    const src = /uniform\s/.test(frag) || /precision/.test(frag) ? frag : `${HEADER}${decl}\n${frag}`;
    this.prog = link(gl, VERT, src);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.loc = {};
  }
  render(t) {
    const { gl, prog } = this;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(prog);
    const set = (k, v) => {
      const l = this.loc[k] ?? (this.loc[k] = gl.getUniformLocation(prog, k));
      if (l == null) return;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (Array.isArray(v)) gl[`uniform${v.length}fv`](l, v);
    };
    set('uTime', t);
    set('uResolution', [gl.canvas.width, gl.canvas.height]);
    for (const k in this.uniforms) set(k, this.uniforms[k]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // Render after all tweens/graph nodes have written uniforms for this frame.
  bind(tl) { tl.add((lt) => this.render(lt), { label: 'shader' }); return this; }
}

function typeOf(v) {
  if (typeof v === 'number') return 'float';
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4) return `vec${v.length}`;
  throw new Error(`ShaderLayer: unsupported uniform value ${JSON.stringify(v)}`);
}
export function link(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('ShaderLayer compile error:\n' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('ShaderLayer link error:\n' + gl.getProgramInfoLog(p));
  return p;
}
