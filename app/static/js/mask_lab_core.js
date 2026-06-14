// =====================================================================
// mask_lab_core.js
// Núcleo compartido del "laboratorio" de etiquetado marco/lente/fondo.
//
// Centraliza el sistema de 3 clases (FONDO/LENTE/MARCO), el render con zoom,
// el pincel pixel-a-pixel (fallback), la inicialización desde la segmentación
// automática, la exportación a SVG y el guardado en el modelo.
//
// Cada variante del laboratorio (flood fill, superpíxeles, scribbles, SAM)
// importa este módulo y solo agrega SU forma rápida de etiquetar, escribiendo
// en `editor.maskPixels` y llamando `editor.render()`.
//
// La salida es SIEMPRE la misma (maskPixels -> PNG marco/lente -> SVG vía
// /_admin_helpers/api/seg_b/apply_mask -> guardar en /_admin_helpers/imgs_to_svg/<id>)
// para que la comparación entre técnicas sea justa.
// =====================================================================

// ---- Estados de cada píxel de la máscara ----
export const FONDO = 0, LENTE = 1, MARCO = 2;

// ============================ Utilidades puras ============================

export function setLoading(on) {
  const el = document.getElementById('loader');
  if (el) el.style.display = on ? 'flex' : 'none';
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function putSVGPreview(containerId, svgText) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (!svgText) return;
  const iframe = document.createElement('iframe');
  iframe.className = 'svgPrev';
  iframe.srcdoc = `<html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0f0f0f}
    svg{max-width:100%;max-height:100%;display:block;margin:auto}
  </style></head><body>${svgText}</body></html>`;
  el.appendChild(iframe);
}

export function downloadSVG(text, name) {
  const blob = new Blob([text], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 400);
}

export async function postFormData(url, formData) {
  const r = await fetch(url, { method: 'POST', body: formData });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---------- normalizar MARCO/LENTE: relleno blanco (#fff) y FONDO NEGRO ----------
// (formato que espera el extrusor 3D de index1.html)
export function normalizeFrameSVGWhite(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return svgText;

    let vb = svg.getAttribute('viewBox');
    let W = 0, H = 0;
    if (vb) {
      const p = vb.trim().split(/\s+/).map(Number);
      W = p[2] || 0; H = p[3] || 0;
    } else {
      W = parseFloat(svg.getAttribute('width') || '0');
      H = parseFloat(svg.getAttribute('height') || '0');
      if (!vb && W > 0 && H > 0) svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    const bigArea = W * H;

    [...doc.querySelectorAll('rect')].forEach(r => {
      const w = parseFloat(r.getAttribute('width') || '0');
      const h = parseFloat(r.getAttribute('height') || '0');
      const area = w * h;
      if (bigArea > 0 && area / bigArea > 0.95) {
        r.parentNode.removeChild(r);
      } else {
        r.setAttribute('fill', 'none');
        r.removeAttribute('stroke');
      }
    });

    [...doc.querySelectorAll('path,polygon,polyline,circle,ellipse')].forEach(el => {
      el.setAttribute('fill', '#ffffff');
      el.removeAttribute('stroke');
      if (!el.getAttribute('fill-rule')) el.setAttribute('fill-rule', 'evenodd');
      if (!el.getAttribute('clip-rule')) el.setAttribute('clip-rule', 'evenodd');
    });

    if (W > 0 && H > 0) {
      const bg = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
      bg.setAttribute('width', String(W)); bg.setAttribute('height', String(H));
      bg.setAttribute('fill', '#000000');
      svg.insertBefore(bg, svg.firstChild);
    }

    [...doc.querySelectorAll('style')].forEach(s => {
      s.textContent = (s.textContent || '').replace(/background\s*:[^;]+;?/gi, '');
    });

    const ser = new XMLSerializer().serializeToString(doc.documentElement);
    return ser.startsWith('<svg') ? ser : svgText;
  } catch {
    return svgText;
  }
}

// ============================ Editor de máscara ============================

const DEFAULT_ELS = {
  framePreviewCanvas: 'framePreviewCanvas',
  zoomCanvas: 'zoomCanvas',
  mGray: 'mGray',
  mMarcoFinal: 'mMarcoFinal',
  mLenteFinal: 'mLenteFinal',
  framePreview: 'framePreview',
  glassPreview: 'glassPreview',
  brushSize: 'brushSize',
  brushSizeVal: 'brushSizeVal',
  zoomLevel: 'zoomLevel',
  zoomLevelVal: 'zoomLevelVal',
  btnUndo: 'btnUndo',
  btnSave: 'btnSave',
  saveMsg: 'saveMsg',
  labTimer: 'labTimer',
};

const DEFAULT_URLS = {
  autoSegFront: '/_admin_helpers/api/seg_b/front',
  autoSegTemple: '/_admin_helpers/api/seg_b/temple/',
  applyMask: '/_admin_helpers/api/seg_b/apply_mask',
};

const ZOOM_W = 420, ZOOM_H = 420;
const MAX_UNDO = 20;

export class MaskLabEditor {
  constructor(opts = {}) {
    this.modelId = opts.modelId ?? null;
    this.els = { ...DEFAULT_ELS, ...(opts.els || {}) };
    this.urls = { ...DEFAULT_URLS, ...(opts.urls || {}) };
    // saveUrl: a dónde POSTear los SVGs finales (página imgs_to_svg del modelo)
    this.saveUrl = opts.saveUrl || `/_admin_helpers/imgs_to_svg/${this.modelId}`;
    this.preloaded = opts.preloaded || {};

    // Estado de la máscara
    this.photoRGBA = null;      // Uint8ClampedArray RGBA del original (copia)
    this.maskPixels = null;     // Uint8Array: FONDO/LENTE/MARCO
    this.maskWidth = 0;
    this.maskHeight = 0;
    this.initialMask = null;    // copia del pre-etiquetado automático (para "resetear")

    // Datos crudos de la auto-segmentación (útiles para las variantes)
    this.auto = { colorURL: '', frameMaskURL: '', innerURL: '' };

    // SVGs generados
    this.lastFrameSVG = '';
    this.lastGlassSVG = '';
    this.lastTempleSVG = '';

    // Zoom + pincel
    this.zoomCenterX = 0;
    this.zoomCenterY = 0;
    this.zoomFactor = 4;
    this.undoStack = [];
    this.isPainting = false;
    this._draggingZoom = false;

    // Acción de la técnica, en el canvas de ZOOM (coords de imagen).
    // Cada variante setea down/drag. El canvas izquierdo siempre mueve el zoom;
    // el canvas de zoom ejecuta la técnica o el pincel fino según el selector.
    this.techHandlers = { down: null, drag: null };

    // Máscara de preview (Uint8 1/0): se dibuja en amarillo encima, sin commit.
    this.previewMask = null;

    // Timer de comparación
    this._t0 = null;
    this._timerInt = null;
  }

  $(key) { return document.getElementById(this.els[key]); }

  // ---------------- Arranque ----------------
  // Pide la auto-segmentación del frente, inicializa la máscara 3-clases,
  // cablea pincel/zoom/undo/guardar y arranca el timer.
  async boot({ closeR = 10, minArea = 1200 } = {}) {
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('model_id', this.modelId ?? '');
      fd.append('close_r', closeR);
      fd.append('min_area', minArea);
      const j = await postFormData(this.urls.autoSegFront, fd);
      if (!j.ok) throw new Error('auto-seg front falló');

      this.auto.colorURL = j.masks?.color || '';
      this.auto.frameMaskURL = j.masks?.frame_mask || '';
      this.auto.innerURL = j.masks?.inner || '';

      if (this.$('mGray')) this.$('mGray').src = this.auto.colorURL;

      // pre-etiquetar marco/lente desde la auto-seg
      const frameSrc = (this.preloaded.svg_frame) || this.auto.frameMaskURL;
      const lenteSrc = (this.preloaded.svg_glasses) || this.auto.innerURL;
      await this.initInteractiveMask(this.auto.colorURL, frameSrc, lenteSrc);

      // SVGs iniciales de referencia (la vista previa grande se actualiza en vivo)
      this.lastFrameSVG = normalizeFrameSVGWhite(j.svgs?.frame || '');
      this.lastGlassSVG = j.svgs?.lenses || '';

      this._wireStandardControls();
      this.startTimer();
    } finally {
      setLoading(false);
    }
  }

  // ---------------- Inicialización de la máscara ----------------
  async initInteractiveMask(photoSrc, frameMaskSrc, innerMaskSrc) {
    const canvas = this.$('framePreviewCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const [photo, frameMask, innerMask] = await Promise.all([
      loadImage(photoSrc),
      loadImage(frameMaskSrc),
      loadImage(innerMaskSrc),
    ]);

    canvas.width = photo.width;
    canvas.height = photo.height;
    this.maskWidth = photo.width;
    this.maskHeight = photo.height;

    ctx.drawImage(photo, 0, 0);
    this.photoRGBA = ctx.getImageData(0, 0, this.maskWidth, this.maskHeight).data.slice();

    const frameData = this._maskDataFrom(frameMask);
    const innerData = this._maskDataFrom(innerMask);

    this.maskPixels = new Uint8Array(this.maskWidth * this.maskHeight);
    for (let pi = 0; pi < this.maskPixels.length; pi++) {
      if (frameData[pi * 4] > 128) this.maskPixels[pi] = MARCO;
      else if (innerData[pi * 4] > 128) this.maskPixels[pi] = LENTE;
      else this.maskPixels[pi] = FONDO;
    }
    this.initialMask = this.maskPixels.slice();

    this.zoomCenterX = this.maskWidth / 2;
    this.zoomCenterY = this.maskHeight / 2;
    this.undoStack = [];
    this.render();
  }

  _maskDataFrom(img) {
    const tmp = document.createElement('canvas');
    tmp.width = this.maskWidth; tmp.height = this.maskHeight;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0, this.maskWidth, this.maskHeight);
    return tctx.getImageData(0, 0, this.maskWidth, this.maskHeight).data;
  }

  // ---------------- Render ----------------
  render() {
    this._renderMaskOverlay();
    this._renderZoomCanvas();
    this._scheduleFinalPreview();   // actualiza marco/lente grandes a la derecha
  }

  _tintFor(klass, r, g, b, out, i) {
    if (klass === MARCO) {
      out[i]   = Math.min(255, r + 90);
      out[i+1] = Math.max(0,   g - 50);
      out[i+2] = Math.max(0,   b - 50);
    } else if (klass === LENTE) {
      out[i]   = Math.max(0,   r - 50);
      out[i+1] = Math.min(255, g + 40);
      out[i+2] = Math.min(255, b + 110);
    } else {
      out[i] = r * 0.22 | 0; out[i+1] = g * 0.22 | 0; out[i+2] = b * 0.22 | 0;
    }
    out[i+3] = 255;
  }

  _renderMaskOverlay() {
    const canvas = this.$('framePreviewCanvas');
    if (!canvas || !this.photoRGBA || !this.maskPixels) return;
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(this.maskWidth, this.maskHeight);
    const d = data.data;
    const pv = this.previewMask;
    for (let pi = 0, i = 0; pi < this.maskPixels.length; pi++, i += 4) {
      this._tintFor(this.maskPixels[pi], this.photoRGBA[i], this.photoRGBA[i+1], this.photoRGBA[i+2], d, i);
      if (pv && pv[pi]) { d[i] = (d[i] + 255) >> 1; d[i+1] = (d[i+1] + 255) >> 1; d[i+2] = d[i+2] >> 1; }
    }
    ctx.putImageData(data, 0, 0);

    if (this.maskWidth > 0) {
      const rW = ZOOM_W / this.zoomFactor, rH = ZOOM_H / this.zoomFactor;
      const rx = this.zoomCenterX - rW / 2, ry = this.zoomCenterY - rH / 2;
      const lw = Math.max(2, this.maskWidth / 250);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,230,0,0.95)';
      ctx.lineWidth = lw;
      ctx.setLineDash([lw * 5, lw * 2]);
      ctx.strokeRect(rx, ry, rW, rH);
      ctx.restore();
    }
  }

  _renderZoomCanvas() {
    const zCanvas = this.$('zoomCanvas');
    if (!zCanvas || !this.photoRGBA || !this.maskPixels) return;
    const ctx = zCanvas.getContext('2d');
    const rectW = ZOOM_W / this.zoomFactor, rectH = ZOOM_H / this.zoomFactor;
    const left = this.zoomCenterX - rectW / 2, top = this.zoomCenterY - rectH / 2;
    const zData = ctx.createImageData(ZOOM_W, ZOOM_H);
    const zd = zData.data;
    for (let zy = 0; zy < ZOOM_H; zy++) {
      for (let zx = 0; zx < ZOOM_W; zx++) {
        const sx = Math.round(left + zx / this.zoomFactor);
        const sy = Math.round(top + zy / this.zoomFactor);
        const zi = (zy * ZOOM_W + zx) * 4;
        if (sx < 0 || sx >= this.maskWidth || sy < 0 || sy >= this.maskHeight) {
          zd[zi] = zd[zi+1] = zd[zi+2] = 30; zd[zi+3] = 255;
          continue;
        }
        const pi = sy * this.maskWidth + sx, ii = pi * 4;
        this._tintFor(this.maskPixels[pi], this.photoRGBA[ii], this.photoRGBA[ii+1], this.photoRGBA[ii+2], zd, zi);
        if (this.previewMask && this.previewMask[pi]) { zd[zi] = (zd[zi] + 255) >> 1; zd[zi+1] = (zd[zi+1] + 255) >> 1; zd[zi+2] = zd[zi+2] >> 1; }
      }
    }
    ctx.putImageData(zData, 0, 0);
  }

  // ---------------- Coordenadas ----------------
  _evToMask(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * this.maskWidth / rect.width),
      y: Math.round((e.clientY - rect.top) * this.maskHeight / rect.height),
    };
  }

  _evToZoomMask(e, zCanvas) {
    const rect = zCanvas.getBoundingClientRect();
    const zx = (e.clientX - rect.left) * ZOOM_W / rect.width;
    const zy = (e.clientY - rect.top) * ZOOM_H / rect.height;
    const left = this.zoomCenterX - (ZOOM_W / this.zoomFactor) / 2;
    const top = this.zoomCenterY - (ZOOM_H / this.zoomFactor) / 2;
    return {
      x: Math.round(left + zx / this.zoomFactor),
      y: Math.round(top + zy / this.zoomFactor),
    };
  }

  _moveZoom(x, y) {
    this.zoomCenterX = Math.max(0, Math.min(this.maskWidth, x));
    this.zoomCenterY = Math.max(0, Math.min(this.maskHeight, y));
    this.render();
  }

  // ---------------- Pincel fallback ----------------
  activeClass() {
    const v = document.querySelector('input[name="brushMode"]:checked')?.value || 'marco';
    return v === 'marco' ? MARCO : v === 'lente' ? LENTE : FONDO;
  }

  paintBrush(cx, cy) {
    if (!this.maskPixels) return;
    const size = parseInt(this.$('brushSize')?.value || '8');
    const klass = this.activeClass();
    const r2 = size * size;
    for (let dy = -size; dy <= size; dy++) {
      for (let dx = -size; dx <= size; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const px = cx + dx, py = cy + dy;
        if (px < 0 || px >= this.maskWidth || py < 0 || py >= this.maskHeight) continue;
        this.maskPixels[py * this.maskWidth + px] = klass;
      }
    }
    this.render();
  }

  // ---------------- API para variantes ----------------
  // Snapshot para deshacer (llamar ANTES de una operación masiva)
  snapshot() {
    if (!this.maskPixels) return;
    this.undoStack.push(this.maskPixels.slice());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  undo() {
    if (this.undoStack.length === 0) return;
    this.maskPixels = this.undoStack.pop();
    this.render();
  }

  // Pinta un conjunto de índices (pi = y*W+x) a una clase
  labelIndices(indices, klass) {
    if (!this.maskPixels) return;
    for (const pi of indices) {
      if (pi >= 0 && pi < this.maskPixels.length) this.maskPixels[pi] = klass;
    }
  }

  // Preview (no-commit): máscara amarilla encima
  setPreview(mask) { this.previewMask = mask; this.render(); }
  clearPreview() { this.previewMask = null; this.render(); }

  // Color [r,g,b] del original en (x,y)
  photoAt(x, y) {
    const i = (y * this.maskWidth + x) * 4;
    return [this.photoRGBA[i], this.photoRGBA[i + 1], this.photoRGBA[i + 2]];
  }

  // Vuelve al pre-etiquetado automático
  resetToAuto() {
    if (!this.initialMask) return;
    this.snapshot();
    this.maskPixels = this.initialMask.slice();
    this.render();
  }

  // Herramienta activa del canvas de zoom: 'tecnica' (default) o 'pincel'
  currentTool() {
    return document.querySelector('input[name="labTool"]:checked')?.value || 'tecnica';
  }

  // ---------------- Morfología binaria (suavizado de bordes) ----------------
  // Erosión/dilatación con elemento estructurante cuadrado, separable (rápido).
  _erodeSquare(src, W, H, r) {
    if (r <= 0) return src;
    const tmp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let v = 1;
        for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= W || !src[row + xx]) { v = 0; break; } }
        tmp[row + x] = v;
      }
    }
    const out = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let v = 1;
        for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= H || !tmp[yy * W + x]) { v = 0; break; } }
        out[y * W + x] = v;
      }
    }
    return out;
  }
  _dilateSquare(src, W, H, r) {
    if (r <= 0) return src;
    const tmp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < W && src[row + xx]) { v = 1; break; } }
        tmp[row + x] = v;
      }
    }
    const out = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let v = 0;
        for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < H && tmp[yy * W + x]) { v = 1; break; } }
        out[y * W + x] = v;
      }
    }
    return out;
  }

  // Binaria del MARCO (1/0) con apertura (y cierre opcional) para suavizar bordes.
  _marcoBinarySmoothed() {
    const W = this.maskWidth, H = this.maskHeight;
    let m = new Uint8Array(W * H);
    for (let pi = 0; pi < m.length; pi++) m[pi] = (this.maskPixels[pi] === MARCO) ? 1 : 0;
    const ro = parseInt(document.getElementById('frameOpen')?.value || '0');
    const rc = parseInt(document.getElementById('frameClose')?.value || '0');
    if (ro > 0) { m = this._erodeSquare(m, W, H, ro); m = this._dilateSquare(m, W, H, ro); }   // apertura
    if (rc > 0) { m = this._dilateSquare(m, W, H, rc); m = this._erodeSquare(m, W, H, rc); }   // cierre
    return m;
  }

  // ---------------- Vista previa en vivo (marco/lente, derecha) ----------------
  _scheduleFinalPreview() {
    clearTimeout(this._finalPreviewT);
    this._finalPreviewT = setTimeout(() => this._updateFinalPreviews(), 120);
  }
  _updateFinalPreviews() {
    const W = this.maskWidth, H = this.maskHeight;
    if (!W || !this.maskPixels) return;
    const marco = this._marcoBinarySmoothed();
    const drawBin = (canvas, isOn) => {
      if (!canvas || !canvas.getContext) return;
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const d = ctx.createImageData(W, H);
      const dd = d.data;
      for (let pi = 0, i = 0; pi < W * H; pi++, i += 4) {
        const on = isOn(pi);
        const v = on ? 255 : 16;
        dd[i] = v; dd[i + 1] = v; dd[i + 2] = v; dd[i + 3] = 255;
      }
      ctx.putImageData(d, 0, 0);
    };
    drawBin(this.$('mMarcoFinal'), (pi) => marco[pi] === 1);
    drawBin(this.$('mLenteFinal'), (pi) => this.maskPixels[pi] === LENTE);
  }

  // ---------------- Patilla: re-segmentar con parámetros y previsualizar ----------------
  async updateTemple() {
    const close_r  = parseInt(document.getElementById('tplClose')?.value || '7');
    const min_area = parseInt(document.getElementById('tplMinArea')?.value || '800');
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('model_id', this.modelId ?? '');
      fd.append('close_r', close_r);
      fd.append('min_area', min_area);
      const j = await postFormData(this.urls.autoSegTemple, fd);
      if (j.ok) {
        this.lastTempleSVG = j.svgs?.temple || '';
        putSVGPreview('templePreview', this.lastTempleSVG);
      }
    } catch (e) {
      console.warn('No se pudo actualizar la patilla:', e);
    } finally {
      setLoading(false);
    }
  }

  // ---------------- Cableado de controles estándar ----------------
  _wireStandardControls() {
    const canvas = this.$('framePreviewCanvas');
    const zCanvas = this.$('zoomCanvas');

    // Canvas normal (izquierda): SIEMPRE mueve la zona de zoom
    if (canvas) {
      canvas.style.cursor = 'move';
      canvas.onmousedown = (e) => {
        this._draggingZoom = true;
        const { x, y } = this._evToMask(e, canvas);
        this._moveZoom(x, y);
      };
      canvas.onmousemove = (e) => {
        if (!this._draggingZoom) return;
        const { x, y } = this._evToMask(e, canvas);
        this._moveZoom(x, y);
      };
      canvas.onmouseup = canvas.onmouseleave = () => { this._draggingZoom = false; };
    }

    // Canvas de zoom (derecha): herramienta = técnica de la variante o pincel fino
    if (zCanvas) {
      zCanvas.style.cursor = 'crosshair';
      zCanvas.onmousedown = (e) => {
        this.isPainting = true;
        const { x, y } = this._evToZoomMask(e, zCanvas);
        if (this.currentTool() === 'pincel') { this.snapshot(); this.paintBrush(x, y); }
        else if (this.techHandlers.down) this.techHandlers.down(x, y, e);
      };
      zCanvas.onmousemove = (e) => {
        if (!this.isPainting) return;
        const { x, y } = this._evToZoomMask(e, zCanvas);
        if (this.currentTool() === 'pincel') this.paintBrush(x, y);
        else if (this.techHandlers.drag) this.techHandlers.drag(x, y, e);
      };
      zCanvas.onmouseup = zCanvas.onmouseleave = () => { this.isPainting = false; };
    }

    // Pincel: tamaño
    this.$('brushSize')?.addEventListener('input', (e) => {
      const v = this.$('brushSizeVal');
      if (v) v.textContent = e.target.value;
    });
    // Zoom
    this.$('zoomLevel')?.addEventListener('input', (e) => {
      this.zoomFactor = parseInt(e.target.value);
      const v = this.$('zoomLevelVal');
      if (v) v.textContent = this.zoomFactor + 'x';
      this.render();
    });
    this.$('btnUndo')?.addEventListener('click', () => this.undo());
    this.$('btnSave')?.addEventListener('click', () => this.saveToModel());

    // Suavizado del marco (apertura/cierre): actualiza label + preview en vivo
    const wireMorph = (id, valId) => {
      const el = document.getElementById(id), v = document.getElementById(valId);
      el?.addEventListener('input', () => {
        if (v) v.textContent = el.value;
        this._scheduleFinalPreview();
      });
    };
    wireMorph('frameOpen', 'frameOpenVal');
    wireMorph('frameClose', 'frameCloseVal');

    // Patillas: labels + botón actualizar
    const tc = document.getElementById('tplClose'), tcv = document.getElementById('tplCloseVal');
    tc?.addEventListener('input', () => { if (tcv) tcv.textContent = tc.value; });
    const ta = document.getElementById('tplMinArea'), tav = document.getElementById('tplMinAreaVal');
    ta?.addEventListener('input', () => { if (tav) tav.textContent = ta.value; });
    document.getElementById('tplUpdate')?.addEventListener('click', () => this.updateTemple());
  }

  // ---------------- Exportar maskPixels -> SVG ----------------
  // Genera PNG marco y lente, los vectoriza en el server y guarda los SVG.
  async _buildSVGsFromMask() {
    const marcoC = document.createElement('canvas');
    marcoC.width = this.maskWidth; marcoC.height = this.maskHeight;
    const marcoCtx = marcoC.getContext('2d');
    const marcoData = marcoCtx.createImageData(this.maskWidth, this.maskHeight);

    const lenteC = document.createElement('canvas');
    lenteC.width = this.maskWidth; lenteC.height = this.maskHeight;
    const lenteCtx = lenteC.getContext('2d');
    const lenteData = lenteCtx.createImageData(this.maskWidth, this.maskHeight);

    // Marco suavizado (apertura/cierre) para que el SVG salga con bordes limpios
    const marcoBin = this._marcoBinarySmoothed();
    for (let pi = 0, i = 0; pi < this.maskPixels.length; pi++, i += 4) {
      const mv = marcoBin[pi] ? 255 : 0;
      const lv = this.maskPixels[pi] === LENTE ? 255 : 0;
      marcoData.data[i] = marcoData.data[i+1] = marcoData.data[i+2] = mv; marcoData.data[i+3] = 255;
      lenteData.data[i] = lenteData.data[i+1] = lenteData.data[i+2] = lv; lenteData.data[i+3] = 255;
    }
    marcoCtx.putImageData(marcoData, 0, 0);
    lenteCtx.putImageData(lenteData, 0, 0);

    const [rMarco, rLente] = await Promise.all([
      fetch(this.urls.applyMask, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mask_b64: marcoC.toDataURL('image/png') }),
      }).then(r => r.json()),
      fetch(this.urls.applyMask, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mask_b64: lenteC.toDataURL('image/png') }),
      }).then(r => r.json()),
    ]);
    if (!rMarco.ok) throw new Error(rMarco.error || 'Error marco');
    if (!rLente.ok) throw new Error(rLente.error || 'Error lente');

    this.lastFrameSVG = normalizeFrameSVGWhite(rMarco.svg_frame || '');
    this.lastGlassSVG = normalizeFrameSVGWhite(rLente.svg_frame || '');
  }

  // Genera el SVG de la patilla con los parámetros actuales si aún no se generó.
  async _ensureTempleSVG() {
    if (this.lastTempleSVG) return;
    try {
      const fd = new FormData();
      fd.append('model_id', this.modelId ?? '');
      fd.append('close_r', document.getElementById('tplClose')?.value || '7');
      fd.append('min_area', document.getElementById('tplMinArea')?.value || '800');
      const j = await postFormData(this.urls.autoSegTemple, fd);
      if (j.ok) this.lastTempleSVG = j.svgs?.temple || '';
    } catch (e) {
      console.warn('No se pudo generar SVG de patilla:', e);
    }
  }

  // ---------------- Guardar en el modelo ----------------
  async saveToModel() {
    const msg = this.$('saveMsg');
    if (!this.maskPixels) { alert('No hay máscara para guardar.'); return; }
    setLoading(true);
    if (msg) msg.textContent = 'Generando SVGs…';
    try {
      await this._buildSVGsFromMask();
      await this._ensureTempleSVG();

      const fd = new FormData();
      fd.append('model_id', String(this.modelId ?? ''));
      if (this.lastFrameSVG) {
        fd.append('svg_frame', new File([new Blob([this.lastFrameSVG], { type: 'image/svg+xml' })], `frame_${this.modelId}.svg`, { type: 'image/svg+xml' }));
      }
      if (this.lastGlassSVG) {
        fd.append('svg_glasses', new File([new Blob([this.lastGlassSVG], { type: 'image/svg+xml' })], `glasses_${this.modelId}.svg`, { type: 'image/svg+xml' }));
      }
      if (this.lastTempleSVG) {
        fd.append('svg_temple', new File([new Blob([this.lastTempleSVG], { type: 'image/svg+xml' })], `temple_${this.modelId}.svg`, { type: 'image/svg+xml' }));
      }

      if (msg) msg.textContent = 'Guardando…';
      const r = await fetch(this.saveUrl, { method: 'POST', body: fd });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error(j?.detail || `HTTP ${r.status}`);

      this.stopTimer();
      if (msg) msg.textContent = `¡Guardado! (${this.elapsed()} s)`;
      if (j.redirect) window.location.assign(j.redirect);
    } catch (err) {
      console.error(err);
      if (msg) msg.textContent = 'Error al guardar';
      alert('No se pudo guardar: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  // ---------------- Timer de comparación ----------------
  startTimer() {
    this._t0 = performance.now();
    const el = this.$('labTimer');
    if (this._timerInt) clearInterval(this._timerInt);
    this._timerInt = setInterval(() => {
      if (el) el.textContent = this.elapsed() + ' s';
    }, 250);
  }
  stopTimer() {
    if (this._timerInt) { clearInterval(this._timerInt); this._timerInt = null; }
  }
  elapsed() {
    if (this._t0 == null) return '0.0';
    return ((performance.now() - this._t0) / 1000).toFixed(1);
  }
}
