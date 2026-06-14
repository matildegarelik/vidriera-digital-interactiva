// =====================================================================
// lab_sam.js — Variante D: SAM por clic (MobileSAM vía ONNX en el server)
// El decoder es de UNA sola máscara: con un punto, SAM devuelve el objeto
// dominante (todos los anteojos). Para aislar el lente usamos puntos
// POSITIVOS (clic) y NEGATIVOS (Shift+clic) que recortan la máscara.
// La máscara candidata se ve en amarillo (preview) y recién al "Asignar"
// se escribe en la clase elegida. Pincel fino como fallback.
// =====================================================================
import { MaskLabEditor, loadImage, setLoading, FONDO } from './mask_lab_core.js';

const editor = new MaskLabEditor({
  modelId: window.MODEL_ID,
  preloaded: window.PRELOADED || {},
});

let ready = false;
let pts = [];      // [[x,y], ...] en coords de imagen original
let lbls = [];     // 1 = positivo, 0 = negativo
let previewArr = null;

const statusEl = document.getElementById('samStatus');
function setStatus(t) { if (statusEl) statusEl.textContent = t; }

async function embed() {
  ready = false;
  setStatus('calculando embedding…');
  setLoading(true);
  try {
    const fd = new FormData();
    fd.append('model_id', editor.modelId ?? '');
    const r = await fetch('/_admin_helpers/api/lab/sam/embed', { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw new Error(j.detail || j.error || 'error');
    ready = true;
    setStatus('listo ✅ — clic = punto +, Shift+clic = punto −');
  } catch (e) {
    console.error(e);
    setStatus('error: ' + e.message);
    alert('SAM no disponible: ' + e.message + '\n\nVerificá onnxruntime y los pesos en app/ml/sam/.');
  } finally {
    setLoading(false);
  }
}

// Decodifica un PNG de máscara (R>128) a Uint8Array (1/0) del tamaño del canvas
async function maskPngToArray(dataurl) {
  const img = await loadImage(dataurl);
  const W = editor.maskWidth, H = editor.maskHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let pi = 0; pi < out.length; pi++) out[pi] = d[pi * 4] > 128 ? 1 : 0;
  return out;
}

// Re-corre el decoder con todos los puntos acumulados y muestra el preview
async function refreshPreview() {
  if (!pts.length) { previewArr = null; editor.clearPreview(); return; }
  setLoading(true);
  try {
    const r = await fetch('/_admin_helpers/api/lab/sam/decode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: editor.modelId, points: pts, labels: lbls }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.detail || j.error || 'error');
    if (j.debug) {
      const dbg = j.debug;
      setStatus(`pts:${pts.length} (+${lbls.filter(l=>l===1).length}/−${lbls.filter(l=>l===0).length}) · iou=${dbg.iou} %pos=${dbg.pos_frac_valid}`);
    }
    previewArr = await maskPngToArray(j.mask_png);
    editor.setPreview(previewArr);
  } catch (e) {
    console.error(e);
    alert('Error SAM decode: ' + e.message);
  } finally {
    setLoading(false);
  }
}

// Clic en el canvas de zoom: agrega punto (+ normal, − con Shift)
editor.techHandlers.down = (x, y, e) => {
  if (!ready) return;
  pts.push([x, y]);
  lbls.push(e && e.shiftKey ? 0 : 1);
  refreshPreview();
};

function clearPoints() {
  pts = []; lbls = []; previewArr = null;
  editor.clearPreview();
  if (ready) setStatus('listo ✅ — clic = punto +, Shift+clic = punto −');
}

// Asignar el preview a la clase activa
function assignPreview() {
  if (!previewArr) { alert('Primero marcá la pieza con clics (preview amarillo).'); return; }
  editor.snapshot();
  const klass = editor.activeClass();
  const mp = editor.maskPixels;
  for (let pi = 0; pi < mp.length; pi++) if (previewArr[pi]) mp[pi] = klass;
  clearPoints();
  editor.render();
}

document.getElementById('samAssign')?.addEventListener('click', assignPreview);
document.getElementById('samClearPts')?.addEventListener('click', clearPoints);
document.getElementById('samReembed')?.addEventListener('click', () => embed());
document.getElementById('samClear')?.addEventListener('click', () => {
  if (!editor.maskPixels) return;
  editor.snapshot();
  editor.maskPixels.fill(FONDO);
  clearPoints();
  editor.render();
});

(async () => {
  await editor.boot();
  await embed();
})();
