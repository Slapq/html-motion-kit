// 节拍表：配乐（make-bgm.mjs）和画面（index.html）共用，保证每个卡点对齐到同一拍。
// 120 BPM → 一拍 0.5s，一小节 2s。
export const BPM = 120, BEAT = 60 / BPM, BAR = BEAT * 4;
export const SECTIONS = {
  intro: [0, 4],   // 前奏：琶音开滤波，军鼓滚奏
  drop: [4, 18],   // 第一段：四拍底鼓
  brk: [18, 20],   // 间奏：抽掉鼓，只留 pad 和上扬
  outro: [24, 28], // 重音后收尾
};
// 所有底鼓时刻（秒）
export function kicks() {
  const out = [];
  for (let t = SECTIONS.drop[0]; t < SECTIONS.brk[0] - 1e-6; t += BEAT) out.push(+t.toFixed(3));
  for (let t = SECTIONS.brk[1]; t < SECTIONS.outro[0] - 1e-6; t += BEAT) out.push(+t.toFixed(3));
  return out;
}
// 距上一次底鼓的时间 → 0..1 的冲击包络（刚打下为 1，按 k 衰减），画面用它做"跟拍"
export function pulse(t, k = 7) {
  const ks = kicks();
  let last = -1;
  for (const x of ks) { if (x <= t) last = x; else break; }
  return last < 0 || t - last > 0.5 ? 0 : Math.exp(-(t - last) * k);
}
