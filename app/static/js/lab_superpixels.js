// =====================================================================
// lab_superpixels.js — Variante A: Superpíxeles + clic
// El server parte la imagen en superpíxeles (SLIC) y los pre-etiqueta con la
// auto-seg. El usuario barre la vista normal y cada superpíxel bajo el cursor
// cambia entero a la clase activa. Pincel fino como fallback.
// Requiere opencv-contrib-python en el backend.
// =====================================================================
import { MaskLabEditor, loadImage, setLoading } from './mask_lab_core.js';

const editor = new MaskLabEditor({
  modelId: window.MODEL_ID,
  preloaded: window.PRELOADED || {},
});

let labelOf = null;        // Int32Array por píxel -> id de superpíxel
let pixelsByLabel = null;  // Array<Array<pi>>
let prelabels = null;      // Array<clase> por superpíxel
let nLabels = 0;
let regionSize = 25;
let lastLabel = -1;

const info = document.getElementById('spInfo');

document.getElementById('spSize')?.addEventListener('input', (e) => {
  regionSize = parseInt(e.target.value);
  const v = document.getElementById('spSizeVal'); if (v) v.textContent = regionSize;
});
document.getElementById('spRegen')?.addEventListener('click', () => loadSuperpixels());
document.getElementById('spReset')?.addEventListener('click', () => applyPrelabels());

// Decodifica el PNG RGB de labels (id = R + G*256 + B*65536)
async function decodeLabelMap(dataurl) {
  const img = await loadImage(dataurl);
  const W = editor.maskWidth, H = editor.maskHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  labelOf = new Int32Array(W * H);
  pixelsByLabel = Array.from({ length: nLabels }, () => []);
  for (let pi = 0; pi < labelOf.length; pi++) {
    const id = d[pi * 4] + (d[pi * 4 + 1] << 8) + (d[pi * 4 + 2] << 16);
    labelOf[pi] = id;
    if (id >= 0 && id < nLabels) pixelsByLabel[id].push(pi);
  }
}

// Re-pinta maskPixels según el pre-etiquetado por superpíxel
function applyPrelabels() {
  if (!labelOf || !prelabels) return;
  editor.snapshot();
  const mp = editor.maskPixels;
  for (let pi = 0; pi < mp.length; pi++) {
    const id = labelOf[pi];
    mp[pi] = (id >= 0 && id < nLabels) ? prelabels[id] : 0;
  }
  editor.initialMask = mp.slice(); // que "Volver a auto" recupere esto
  editor.render();
}

function setSuperpixel(labelId, klass) {
  if (labelId < 0 || labelId >= nLabels) return;
  const px = pixelsByLabel[labelId];
  const mp = editor.maskPixels;
  for (let i = 0; i < px.length; i++) mp[px[i]] = klass;
}

// Barrido en el canvas de zoom: cambia el superpíxel bajo el cursor.
// (el canvas izquierdo mueve la zona de zoom)
editor.techHandlers.down = (x, y) => {
  if (!labelOf) return;
  editor.snapshot();
  lastLabel = -1;
  paintAt(x, y);
};
editor.techHandlers.drag = (x, y) => {
  if (!labelOf) return;
  paintAt(x, y);
};

function paintAt(x, y) {
  if (!labelOf) return;
  if (x < 0 || x >= editor.maskWidth || y < 0 || y >= editor.maskHeight) return;
  const id = labelOf[y * editor.maskWidth + x];
  if (id === lastLabel) return; // evitar trabajo repetido en drag
  lastLabel = id;
  setSuperpixel(id, editor.activeClass());
  editor.render();
}

async function loadSuperpixels() {
  setLoading(true);
  if (info) info.textContent = 'Calculando superpíxeles…';
  try {
    const fd = new FormData();
    fd.append('model_id', editor.modelId ?? '');
    fd.append('region_size', regionSize);
    const r = await fetch('/_admin_helpers/api/lab/superpixels', { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw new Error(j.detail || j.error || 'error');
    nLabels = j.n_labels;
    prelabels = j.prelabels;
    await decodeLabelMap(j.labels_png);
    applyPrelabels();
    if (info) info.textContent = `${nLabels} superpíxeles`;
  } catch (e) {
    console.error(e);
    if (info) info.textContent = 'Error: ' + e.message;
    alert('No se pudieron generar superpíxeles: ' + e.message +
          '\n\n¿Está instalado opencv-contrib-python?');
  } finally {
    setLoading(false);
  }
}

// Primero boot (auto-seg + canvas), luego superpíxeles
(async () => {
  await editor.boot();
  await loadSuperpixels();
})();
