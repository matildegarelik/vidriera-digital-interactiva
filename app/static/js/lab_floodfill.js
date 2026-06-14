// =====================================================================
// lab_floodfill.js — Variante B: Varita mágica / flood fill
// Clic en la vista normal -> rellena píxeles de color similar con la clase
// activa (marco/lente/fondo). Sin backend. El pincel fino queda como fallback.
// =====================================================================
import { MaskLabEditor } from './mask_lab_core.js';

const editor = new MaskLabEditor({
  modelId: window.MODEL_ID,
  preloaded: window.PRELOADED || {},
});

// Tolerancia de color
let tol = 28;
let global = false;
const tolEl = document.getElementById('ffTol');
const tolVal = document.getElementById('ffTolVal');
tolEl?.addEventListener('input', () => { tol = parseInt(tolEl.value); if (tolVal) tolVal.textContent = tol; });
document.getElementById('ffGlobal')?.addEventListener('change', (e) => { global = e.target.checked; });
document.getElementById('ffReset')?.addEventListener('click', () => editor.resetToAuto());

function colorDist2(i, r0, g0, b0) {
  const dr = editor.photoRGBA[i] - r0;
  const dg = editor.photoRGBA[i + 1] - g0;
  const db = editor.photoRGBA[i + 2] - b0;
  return dr * dr + dg * dg + db * db;
}

// Flood fill contiguo (4-conexo) desde (sx,sy)
function floodContiguous(sx, sy, klass) {
  const W = editor.maskWidth, H = editor.maskHeight;
  const start = sy * W + sx;
  const r0 = editor.photoRGBA[start * 4], g0 = editor.photoRGBA[start * 4 + 1], b0 = editor.photoRGBA[start * 4 + 2];
  const t2 = tol * tol;
  const visited = new Uint8Array(W * H);
  const stack = [start];
  visited[start] = 1;
  const mp = editor.maskPixels;
  while (stack.length) {
    const pi = stack.pop();
    mp[pi] = klass;
    const x = pi % W, y = (pi / W) | 0;
    const nb = [];
    if (x > 0) nb.push(pi - 1);
    if (x < W - 1) nb.push(pi + 1);
    if (y > 0) nb.push(pi - W);
    if (y < H - 1) nb.push(pi + W);
    for (const np of nb) {
      if (visited[np]) continue;
      visited[np] = 1;
      if (colorDist2(np * 4, r0, g0, b0) <= t2) stack.push(np);
    }
  }
}

// Selección global por color (sin contigüidad)
function floodGlobal(sx, sy, klass) {
  const W = editor.maskWidth, H = editor.maskHeight;
  const start = sy * W + sx;
  const r0 = editor.photoRGBA[start * 4], g0 = editor.photoRGBA[start * 4 + 1], b0 = editor.photoRGBA[start * 4 + 2];
  const t2 = tol * tol;
  const mp = editor.maskPixels;
  for (let pi = 0; pi < mp.length; pi++) {
    if (colorDist2(pi * 4, r0, g0, b0) <= t2) mp[pi] = klass;
  }
}

function doFill(x, y) {
  if (!editor.maskPixels) return;
  if (x < 0 || x >= editor.maskWidth || y < 0 || y >= editor.maskHeight) return;
  editor.snapshot();
  const klass = editor.activeClass();
  if (global) floodGlobal(x, y, klass);
  else floodContiguous(x, y, klass);
  editor.render();
}

// En el canvas de zoom: clic = flood fill en ese punto preciso.
// (el canvas izquierdo mueve la zona de zoom)
editor.techHandlers.down = (x, y) => doFill(x, y);

editor.boot();
