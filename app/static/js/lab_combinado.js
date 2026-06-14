// =====================================================================
// lab_combinado.js — Variante C: Scribbles + auto-seg + ajuste
// El usuario traza pocos garabatos por clase; el server propaga con
// watershed sembrado por esos scribbles + los priors de la auto-seg.
// Luego ajuste fino con el pincel.
// =====================================================================
import { MaskLabEditor, loadImage, setLoading, FONDO, LENTE, MARCO } from './mask_lab_core.js';

const editor = new MaskLabEditor({
  modelId: window.MODEL_ID,
  preloaded: window.PRELOADED || {},
});

const seeds = { marco: [], lente: [], fondo: [] };
let radius = 6;

const classKey = () => {
  const k = editor.activeClass();
  return k === MARCO ? 'marco' : k === LENTE ? 'lente' : 'fondo';
};

document.getElementById('scRadius')?.addEventListener('input', (e) => {
  radius = parseInt(e.target.value);
  const v = document.getElementById('scRadiusVal'); if (v) v.textContent = radius;
});

// Pinta un punto del scribble en maskPixels (feedback visual)
function paintSeedDot(x, y, klass) {
  const r = 3, W = editor.maskWidth, H = editor.maskHeight, mp = editor.maskPixels;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    const px = x + dx, py = y + dy;
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    mp[py * W + px] = klass;
  }
}

// Trazos en el canvas de zoom (preciso). El izquierdo mueve la zona de zoom.
editor.techHandlers.down = (x, y) => {
  editor.snapshot();
  seeds[classKey()].push([x, y]);
  paintSeedDot(x, y, editor.activeClass());
  editor.render();
};
editor.techHandlers.drag = (x, y) => {
  seeds[classKey()].push([x, y]);
  paintSeedDot(x, y, editor.activeClass());
  editor.render();
};

// Aplica un PNG de etiquetas (canal R = clase 0/1/2) a maskPixels
async function applyLabelPng(dataurl) {
  const img = await loadImage(dataurl);
  const c = document.createElement('canvas');
  c.width = editor.maskWidth; c.height = editor.maskHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, editor.maskWidth, editor.maskHeight);
  const d = ctx.getImageData(0, 0, editor.maskWidth, editor.maskHeight).data;
  const mp = editor.maskPixels;
  for (let pi = 0; pi < mp.length; pi++) mp[pi] = d[pi * 4]; // R = clase
  editor.render();
}

document.getElementById('scRun')?.addEventListener('click', async () => {
  const total = seeds.marco.length + seeds.lente.length + seeds.fondo.length;
  if (total === 0) { alert('Dibujá al menos un trazo de alguna clase.'); return; }
  setLoading(true);
  try {
    editor.snapshot();
    const r = await fetch('/_admin_helpers/api/lab/scribble_seg', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: editor.modelId,
        seeds,
        radius,
        use_auto: document.getElementById('scUseAuto')?.checked ?? true,
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.detail || j.error || 'error');
    await applyLabelPng(j.label_png);
  } catch (e) {
    console.error(e);
    alert('Error en watershed: ' + e.message);
  } finally {
    setLoading(false);
  }
});

document.getElementById('scClear')?.addEventListener('click', () => {
  seeds.marco = []; seeds.lente = []; seeds.fondo = [];
  editor.resetToAuto();
});

editor.boot();
