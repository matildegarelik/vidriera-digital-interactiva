// --- util ---

function setLoading(on){
  const el = document.getElementById('loader');
  if (el) el.style.display = on ? 'flex' : 'none';
}
function putSVGPreview(containerId, svgText){
  const el = document.getElementById(containerId);
  if(!el) return;
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
function downloadSVG(text, name){
  const blob = new Blob([text], {type:'image/svg+xml'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 400);
}
async function postFormData(url, formData){
  const r = await fetch(url, { method:'POST', body: formData });
  if (!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}

// ---------- normalizar MARCO: blanco (#fff) y FONDO NEGRO ----------
function normalizeFrameSVGWhite(svgText){
  try{
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return svgText;

    // viewBox / size
    let vb = svg.getAttribute('viewBox');
    let W = 0, H = 0;
    if (vb){
      const p = vb.trim().split(/\s+/).map(Number);
      W = p[2]||0; H = p[3]||0;
    }else{
      W = parseFloat(svg.getAttribute('width')||'0');
      H = parseFloat(svg.getAttribute('height')||'0');
      if (!vb && W>0 && H>0) svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    const bigArea = W*H;

    // 1) eliminar rects de fondo casi del tamaño total
    [...doc.querySelectorAll('rect')].forEach(r=>{
      const w = parseFloat(r.getAttribute('width')||'0');
      const h = parseFloat(r.getAttribute('height')||'0');
      const area = w*h;
      if (bigArea>0 && area/bigArea>0.95){
        r.parentNode.removeChild(r);
      }else{
        r.setAttribute('fill','none');
        r.removeAttribute('stroke');
      }
    });

    // 2) asegurar relleno blanco sin stroke en paths/polygons
    [...doc.querySelectorAll('path,polygon,polyline,circle,ellipse')].forEach(el=>{
      el.setAttribute('fill','#ffffff');
      el.removeAttribute('stroke');
      if (!el.getAttribute('fill-rule')) el.setAttribute('fill-rule','evenodd');
      if (!el.getAttribute('clip-rule')) el.setAttribute('clip-rule','evenodd');
    });

    // 3) insertar fondo negro como PRIMER hijo
    if (W>0 && H>0){
      const bg = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x','0'); bg.setAttribute('y','0');
      bg.setAttribute('width', String(W)); bg.setAttribute('height', String(H));
      bg.setAttribute('fill', '#000000');
      svg.insertBefore(bg, svg.firstChild);
    }

    // 4) limpiar estilos que definan background CSS
    [...doc.querySelectorAll('style')].forEach(s=>{
      s.textContent = (s.textContent||'').replace(/background\s*:[^;]+;?/gi,'');
    });

    const ser = new XMLSerializer().serializeToString(doc.documentElement);
    return ser.startsWith('<svg') ? ser : svgText;
  }catch{
    return svgText;
  }
}

// ---------- UI refs ----------
const ui = {
  frontFile: document.getElementById('frontFile'),
  sideFile : document.getElementById('sideFile'),
  closeR   : document.getElementById('closeR'),
  minArea  : document.getElementById('minArea'),
  innerAdjust: document.getElementById('innerAdjust'),
  closeRSide: document.getElementById('closeRSide'),
  minAreaSide: document.getElementById('minAreaSide'),
  // value displays
  closeRVal: document.getElementById('closeRVal'),
  minAreaVal: document.getElementById('minAreaVal'),
  innerAdjustVal: document.getElementById('innerAdjustVal'),
  // masks
  mGray:  document.getElementById('mGray'),
  mSil:   document.getElementById('mSil'),
  mInner: document.getElementById('mInner'),
  // previews
  framePrev:  'framePreview',
  glassPrev:  'glassPreview',
  templePrev: 'templePreview',
  // buttons
  btnFrontUpdate: document.getElementById('btnFrontUpdate'),
  btnSideUpdate : document.getElementById('btnSideUpdate'),
  btnDownloadFrame: document.getElementById('btnDownloadFrame'),
  btnDownloadGlass: document.getElementById('btnDownloadGlass'),
  btnDownloadTemple: document.getElementById('btnDownloadTemple'),
  // save
  formSave: document.getElementById('formSave'),
  fFrame: document.getElementById('svgFrameField'),
  fGlass: document.getElementById('svgGlassField'),
  fTemple: document.getElementById('svgTempleField'),
  saveMsg: document.getElementById('saveMsg')
};

let lastFrameSVG = '';
let lastGlassSVG = '';
let lastTempleSVG = '';

// ======================== CANVAS INTERACTIVO (PINCEL) ========================
// Estados de la máscara: FONDO=0 (excluido), LENTE=1, MARCO=2
const FONDO = 0, LENTE = 1, MARCO = 2;

let photoRGBA  = null;   // Uint8ClampedArray RGBA del original (copia)
let maskPixels = null;   // Uint8Array por pixel: FONDO=0, LENTE=1, MARCO=2
let maskWidth  = 0;
let maskHeight = 0;
const MAX_UNDO = 15;
let undoStack  = [];
let isPainting = false;

// --- Zoom ---
const ZOOM_W = 420, ZOOM_H = 420;   // resolución interna del canvas de zoom
let zoomCenterX = 0, zoomCenterY = 0;
let zoomFactor  = 4;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Dibuja foto con overlay según estado + rectángulo amarillo de zoom */
function renderMaskOverlay() {
  const canvas = document.getElementById('framePreviewCanvas');
  if (!canvas || !photoRGBA || !maskPixels) return;
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(maskWidth, maskHeight);
  const d = data.data;
  for (let pi = 0, i = 0; pi < maskPixels.length; pi++, i += 4) {
    const r = photoRGBA[i], g = photoRGBA[i+1], b = photoRGBA[i+2];
    if (maskPixels[pi] === MARCO) {
      d[i]   = Math.min(255, r + 90);
      d[i+1] = Math.max(0,   g - 50);
      d[i+2] = Math.max(0,   b - 50);
    } else if (maskPixels[pi] === LENTE) {
      d[i]   = Math.max(0,   r - 50);
      d[i+1] = Math.min(255, g + 40);
      d[i+2] = Math.min(255, b + 110);
    } else {
      d[i] = r * 0.22 | 0; d[i+1] = g * 0.22 | 0; d[i+2] = b * 0.22 | 0;
    }
    d[i+3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  // Rectángulo indicador de zona de zoom
  if (maskWidth > 0) {
    const rW = ZOOM_W / zoomFactor, rH = ZOOM_H / zoomFactor;
    const rx = zoomCenterX - rW / 2,  ry = zoomCenterY - rH / 2;
    const lw = Math.max(2, maskWidth / 250);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,230,0,0.95)';
    ctx.lineWidth = lw;
    ctx.setLineDash([lw * 5, lw * 2]);
    ctx.strokeRect(rx, ry, rW, rH);
    ctx.restore();
  }
}

/** Renderiza el canvas de zoom con la zona seleccionada escalada */
function renderZoomCanvas() {
  const zCanvas = document.getElementById('zoomCanvas');
  if (!zCanvas || !photoRGBA || !maskPixels) return;
  const ctx = zCanvas.getContext('2d');
  const rectW = ZOOM_W / zoomFactor, rectH = ZOOM_H / zoomFactor;
  const left  = zoomCenterX - rectW / 2, top = zoomCenterY - rectH / 2;
  const zData = ctx.createImageData(ZOOM_W, ZOOM_H);
  const zd = zData.data;
  for (let zy = 0; zy < ZOOM_H; zy++) {
    for (let zx = 0; zx < ZOOM_W; zx++) {
      const sx = Math.round(left + zx / zoomFactor);
      const sy = Math.round(top  + zy / zoomFactor);
      const zi = (zy * ZOOM_W + zx) * 4;
      if (sx < 0 || sx >= maskWidth || sy < 0 || sy >= maskHeight) {
        zd[zi] = zd[zi+1] = zd[zi+2] = 30; zd[zi+3] = 255;
        continue;
      }
      const pi = sy * maskWidth + sx, ii = pi * 4;
      const r = photoRGBA[ii], g = photoRGBA[ii+1], b = photoRGBA[ii+2];
      if (maskPixels[pi] === MARCO) {
        zd[zi]   = Math.min(255, r + 90);
        zd[zi+1] = Math.max(0,   g - 50);
        zd[zi+2] = Math.max(0,   b - 50);
      } else if (maskPixels[pi] === LENTE) {
        zd[zi]   = Math.max(0,   r - 50);
        zd[zi+1] = Math.min(255, g + 40);
        zd[zi+2] = Math.min(255, b + 110);
      } else {
        zd[zi] = r * 0.22 | 0; zd[zi+1] = g * 0.22 | 0; zd[zi+2] = b * 0.22 | 0;
      }
      zd[zi+3] = 255;
    }
  }
  ctx.putImageData(zData, 0, 0);
}

function renderAll() {
  renderMaskOverlay();
  renderZoomCanvas();
}

/** Carga foto, frame_mask e inner_mask, inicializa estado 3-zonas, activa pincel.
 *  MARCO  = frame_mask blanco
 *  LENTE  = inner_mask blanco (y no es marco)
 *  FONDO  = todo lo demás (fuera de los lentes)
 */
async function initInteractiveMask(photoSrc, frameMaskSrc, innerMaskSrc) {
  const canvas = document.getElementById('framePreviewCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const [photo, frameMask, innerMask] = await Promise.all([
    loadImage(photoSrc),
    loadImage(frameMaskSrc),
    loadImage(innerMaskSrc)
  ]);

  canvas.width  = photo.width;
  canvas.height = photo.height;
  maskWidth  = photo.width;
  maskHeight = photo.height;

  ctx.drawImage(photo, 0, 0);
  photoRGBA = ctx.getImageData(0, 0, maskWidth, maskHeight).data.slice();

  // Extraer frame_mask
  const tmp = document.createElement('canvas');
  tmp.width = maskWidth; tmp.height = maskHeight;
  const tCtx = tmp.getContext('2d');
  tCtx.drawImage(frameMask, 0, 0, maskWidth, maskHeight);
  const frameData = tCtx.getImageData(0, 0, maskWidth, maskHeight).data;

  // Extraer inner_mask
  const tmp2 = document.createElement('canvas');
  tmp2.width = maskWidth; tmp2.height = maskHeight;
  const tCtx2 = tmp2.getContext('2d');
  tCtx2.drawImage(innerMask, 0, 0, maskWidth, maskHeight);
  const innerData = tCtx2.getImageData(0, 0, maskWidth, maskHeight).data;

  maskPixels = new Uint8Array(maskWidth * maskHeight);
  for (let pi = 0; pi < maskPixels.length; pi++) {
    if (frameData[pi * 4] > 128) {
      maskPixels[pi] = MARCO;
    } else if (innerData[pi * 4] > 128) {
      maskPixels[pi] = LENTE;
    } else {
      maskPixels[pi] = FONDO;
    }
  }

  // Zoom: inicializar en el centro de la imagen
  zoomCenterX = maskWidth / 2;
  zoomCenterY = maskHeight / 2;

  undoStack = [];
  renderAll();

  const toolbar = document.getElementById('brushToolbar');
  if (toolbar) toolbar.style.display = 'block';

  // Canvas principal: click/drag mueve la zona de zoom (cursor "mover")
  canvas.style.cursor = 'move';
  let _draggingZoom = false;
  canvas.onmousedown = (e) => {
    _draggingZoom = true;
    const { x, y } = evToMask(e, canvas);
    zoomCenterX = Math.max(0, Math.min(maskWidth,  x));
    zoomCenterY = Math.max(0, Math.min(maskHeight, y));
    renderAll();
  };
  canvas.onmousemove = (e) => {
    if (!_draggingZoom) return;
    const { x, y } = evToMask(e, canvas);
    zoomCenterX = Math.max(0, Math.min(maskWidth,  x));
    zoomCenterY = Math.max(0, Math.min(maskHeight, y));
    renderAll();
  };
  canvas.onmouseup = canvas.onmouseleave = () => { _draggingZoom = false; };

  // Canvas de zoom: pintar con pincel
  const zCanvas = document.getElementById('zoomCanvas');
  if (zCanvas) {
    zCanvas.style.cursor = 'crosshair';
    zCanvas.onmousedown = (e) => {
      isPainting = true;
      undoStack.push(maskPixels.slice());
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      paintBrush(...evToZoomMask(e, zCanvas));
    };
    zCanvas.onmousemove = (e) => {
      if (!isPainting) return;
      paintBrush(...evToZoomMask(e, zCanvas));
    };
    zCanvas.onmouseup = zCanvas.onmouseleave = () => { isPainting = false; };
  }
}

function evToMask(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - rect.left) * maskWidth  / rect.width),
    y: Math.round((e.clientY - rect.top)  * maskHeight / rect.height)
  };
}

/** Convierte coords del canvas de zoom → coords en pixels de la imagen original */
function evToZoomMask(e, zCanvas) {
  const rect = zCanvas.getBoundingClientRect();
  const zx = (e.clientX - rect.left) * ZOOM_W / rect.width;
  const zy = (e.clientY - rect.top)  * ZOOM_H / rect.height;
  const left = zoomCenterX - (ZOOM_W / zoomFactor) / 2;
  const top  = zoomCenterY - (ZOOM_H / zoomFactor) / 2;
  return [
    Math.round(left + zx / zoomFactor),
    Math.round(top  + zy / zoomFactor)
  ];
}

function paintBrush(cx, cy) {
  if (!maskPixels) return;
  const size = parseInt(document.getElementById('brushSize')?.value || '8');
  const mode = document.querySelector('input[name="brushMode"]:checked')?.value || 'marco';
  const newVal = mode === 'marco' ? MARCO : mode === 'lente' ? LENTE : FONDO;
  const r2 = size * size;
  for (let dy = -size; dy <= size; dy++) {
    for (let dx = -size; dx <= size; dx++) {
      if (dx*dx + dy*dy > r2) continue;
      const px = cx + dx, py = cy + dy;
      if (px < 0 || px >= maskWidth || py < 0 || py >= maskHeight) continue;
      maskPixels[py * maskWidth + px] = newVal;
    }
  }
  renderAll();
}

function undoMaskEdit() {
  if (undoStack.length === 0) return;
  maskPixels = undoStack.pop();
  renderAll();
}

/** Genera dos máscaras PNG (marco y lente) y actualiza ambos SVGs en el servidor. */
async function applyEditedMask() {
  if (!maskPixels || !maskWidth || !maskHeight) {
    alert('Primero generá una máscara con "Actualizar máscaras".');
    return;
  }

  const marcoC = document.createElement('canvas');
  marcoC.width = maskWidth; marcoC.height = maskHeight;
  const marcoCtx = marcoC.getContext('2d');
  const marcoData = marcoCtx.createImageData(maskWidth, maskHeight);

  const lenteC = document.createElement('canvas');
  lenteC.width = maskWidth; lenteC.height = maskHeight;
  const lenteCtx = lenteC.getContext('2d');
  const lenteData = lenteCtx.createImageData(maskWidth, maskHeight);

  for (let pi = 0, i = 0; pi < maskPixels.length; pi++, i += 4) {
    const mv = maskPixels[pi] === MARCO ? 255 : 0;
    const lv = maskPixels[pi] === LENTE ? 255 : 0;
    marcoData.data[i] = marcoData.data[i+1] = marcoData.data[i+2] = mv; marcoData.data[i+3] = 255;
    lenteData.data[i] = lenteData.data[i+1] = lenteData.data[i+2] = lv; lenteData.data[i+3] = 255;
  }
  marcoCtx.putImageData(marcoData, 0, 0);
  lenteCtx.putImageData(lenteData, 0, 0);

  // Mostrar máscaras finales en la fila de referencia
  const mMarcoFinal = document.getElementById('mMarcoFinal');
  const mLenteFinal = document.getElementById('mLenteFinal');
  if (mMarcoFinal) { mMarcoFinal.src = marcoC.toDataURL('image/png'); mMarcoFinal.style.opacity = '1'; document.getElementById('mMarcoFinalHint')?.remove(); }
  if (mLenteFinal) { mLenteFinal.src = lenteC.toDataURL('image/png'); mLenteFinal.style.opacity = '1'; document.getElementById('mLenteFinalHint')?.remove(); }

  setLoading(true);
  try {
    const [rMarco, rLente] = await Promise.all([
      fetch('/_admin_helpers/api/seg_b/apply_mask', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ mask_b64: marcoC.toDataURL('image/png') })
      }).then(r => r.json()),
      fetch('/_admin_helpers/api/seg_b/apply_mask', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ mask_b64: lenteC.toDataURL('image/png') })
      }).then(r => r.json())
    ]);
    if (!rMarco.ok) throw new Error(rMarco.error || 'Error marco');
    if (!rLente.ok) throw new Error(rLente.error || 'Error lente');

    lastFrameSVG = normalizeFrameSVGWhite(rMarco.svg_frame || '');
    lastGlassSVG = normalizeFrameSVGWhite(rLente.svg_frame || '');
    putSVGPreview(ui.framePrev, lastFrameSVG);
    putSVGPreview(ui.glassPrev, lastGlassSVG);
  } catch (err) {
    alert('Error al generar SVGs: ' + err.message);
  } finally {
    setLoading(false);
  }
}
// ============================================================================

// ---------- FRONT: pedir al back y mostrar ----------
// usePreloaded=true  → carga inicial: usa SVGs guardados si existen
// usePreloaded=false → restablecer: usa siempre la segmentación del servidor
async function requestFront(usePreloaded = true){
  const fd = new FormData();
  fd.append('model_id', MODEL_ID ?? '');
  fd.append('close_r', ui.closeR.value);
  fd.append('min_area', ui.minArea.value);
  if (ui.frontFile.files?.[0]) fd.append('image', ui.frontFile.files[0]);

  setLoading(true);
  try{
    const j = await postFormData('/_admin_helpers/api/seg_b/front', fd);
    if (!j.ok) throw new Error('api front');

    // masks
    if (ui.mGray)  ui.mGray.src  = j.masks?.gray  || '';
    if (ui.mSil)   ui.mSil.src   = j.masks?.sil   || '';
    if (ui.mInner) ui.mInner.src = j.masks?.inner || '';

    // Canvas interactivo: foto + máscaras de zonas
    console.log('[dbg] masks keys:', j.masks ? Object.keys(j.masks) : 'sin masks');
    console.log('[dbg] PRELOADED:', JSON.stringify({svg_frame: PRELOADED?.svg_frame ? '(set)' : '', svg_glasses: PRELOADED?.svg_glasses ? '(set)' : ''}));
    const photoSrc = j.masks?.color || j.masks?.gray || '';
    if (photoSrc) {
      const frameSrc = (usePreloaded && PRELOADED?.svg_frame)   ? PRELOADED.svg_frame   : j.masks?.frame_mask || '';
      const lenteSrc = (usePreloaded && PRELOADED?.svg_glasses) ? PRELOADED.svg_glasses : j.masks?.inner      || '';
      console.log('[dbg] frameSrc:', frameSrc ? frameSrc.slice(0,80) : '(vacío)', '| lenteSrc:', lenteSrc ? lenteSrc.slice(0,80) : '(vacío)');
      if (frameSrc && lenteSrc) {
        await initInteractiveMask(photoSrc, frameSrc, lenteSrc).catch(async e => {
          console.warn('Error iniciando canvas interactivo con SVG guardado, reintentando con máscaras binarias:', e);
          const fbFrame = j.masks?.frame_mask || '';
          const fbLente = j.masks?.inner      || '';
          if (fbFrame && fbLente) {
            await initInteractiveMask(photoSrc, fbFrame, fbLente).catch(e2 => {
              console.warn('Error iniciando canvas interactivo (fallback):', e2);
            });
          }
        });
      } else {
        console.warn('[dbg] initInteractiveMask no llamado: frameSrc vacío o lenteSrc vacío');
      }
    } else {
      console.warn('[dbg] initInteractiveMask no llamado: sin photoSrc (color y gray ausentes)');
    }

    // svgs
    lastFrameSVG = normalizeFrameSVGWhite(j.svgs?.frame || j.svgs?.frame_svg || '');
    lastGlassSVG = (j.svgs?.lenses || j.svgs?.glass_svg || '');

    putSVGPreview(ui.framePrev, lastFrameSVG);
    putSVGPreview(ui.glassPrev, lastGlassSVG);
  }finally{
    setLoading(false);
  }
}
ui.btnFrontUpdate.addEventListener('click', ()=>requestFront(false));

// Update value displays
ui.closeR.addEventListener('input', ()=> ui.closeRVal.textContent = ui.closeR.value);
ui.minArea.addEventListener('input', ()=> ui.minAreaVal.textContent = ui.minArea.value);

// Pincel: tamaño
document.getElementById('brushSize')?.addEventListener('input', e => {
  const v = document.getElementById('brushSizeVal');
  if (v) v.textContent = e.target.value;
});
// Zoom: nivel
document.getElementById('zoomLevel')?.addEventListener('input', e => {
  zoomFactor = parseInt(e.target.value);
  const v = document.getElementById('zoomLevelVal');
  if (v) v.textContent = zoomFactor + 'x';
  if (photoRGBA) renderAll();
});
document.getElementById('btnUndo')?.addEventListener('click', undoMaskEdit);
document.getElementById('btnApplyMask')?.addEventListener('click', applyEditedMask);

// ---------- TEMPLE: pedir al back y mostrar ----------
async function requestTemple(){
  const fd = new FormData();
  fd.append('model_id', MODEL_ID ?? '');
  fd.append('close_r', ui.closeRSide.value);
  fd.append('min_area', ui.minAreaSide.value);
  if (ui.sideFile.files?.[0]) fd.append('image', ui.sideFile.files[0]);

  setLoading(true);
  try{
    const j = await postFormData('/_admin_helpers/api/seg_b/temple/', fd);
    if (!j.ok) throw new Error('api temple');

    lastTempleSVG = (j.svgs?.temple || j.svgs?.temple_svg || '');
    putSVGPreview(ui.templePrev, lastTempleSVG);
  }finally{
    setLoading(false);
  }
}
ui.btnSideUpdate.addEventListener('click', ()=>requestTemple());

// ---------- Descargas ----------
ui.btnDownloadFrame.addEventListener('click', ()=> lastFrameSVG && downloadSVG(lastFrameSVG, 'marco.svg'));
ui.btnDownloadGlass.addEventListener('click', ()=> lastGlassSVG && downloadSVG(lastGlassSVG, 'lentes.svg'));
ui.btnDownloadTemple.addEventListener('click',()=> lastTempleSVG && downloadSVG(lastTempleSVG,'patilla.svg'));

// ---------- Guardar en modelo ----------
ui.formSave.addEventListener('submit', async (e)=>{
  e.preventDefault();

  // Si hay máscara pintada, aplicar pincel antes de guardar (por si se olvidó)
  if (maskPixels) {
    await applyEditedMask().catch(err => console.warn('applyEditedMask en save:', err));
  }

  if (!lastFrameSVG && !lastGlassSVG && !lastTempleSVG){
    alert('Generá los SVG antes de guardar.');
    return;
  }

  const fd = new FormData();
  fd.append('model_id', String(MODEL_ID ?? ''));

  if (lastFrameSVG){
    const blob = new Blob([lastFrameSVG], { type: 'image/svg+xml' });
    fd.append('svg_frame', new File([blob], `frame_${MODEL_ID}.svg`, { type:'image/svg+xml' }));
  }
  if (lastGlassSVG){
    const blob = new Blob([lastGlassSVG], { type: 'image/svg+xml' });
    fd.append('svg_glasses', new File([blob], `glasses_${MODEL_ID}.svg`, { type:'image/svg+xml' }));
  }
  if (lastTempleSVG){
    const blob = new Blob([lastTempleSVG], { type: 'image/svg+xml' });
    fd.append('svg_temple', new File([blob], `temple_${MODEL_ID}.svg`, { type:'image/svg+xml' }));
  }

  ui.saveMsg.textContent = 'Guardando…';
  setLoading(true);
  try{
    const r = await fetch(ui.formSave.action, { method:'POST', body: fd });
    const j = await r.json().catch(()=>null);
    if (!r.ok || !j || !j.ok) throw new Error(j?.detail || `HTTP ${r.status}`);

    ui.saveMsg.textContent = '¡Guardado!';
    if (j.redirect){ window.location.assign(j.redirect); }
  }catch(err){
    console.error(err);
    ui.saveMsg.textContent = 'Error al guardar';
    alert('No se pudo guardar los SVG.');
  }finally{
    setLoading(false);
    setTimeout(()=> ui.saveMsg.textContent='', 2000);
  }
});

// ---------- Autoload con imágenes precargadas ----------
function hideUploadsIfPreloaded(){
  try {
    if (window.PRELOADED) {
      if (PRELOADED.front) {
        const row = document.getElementById('frontUploadRow');
        if (row) row.style.display = 'none';
      }
      if (PRELOADED.temple) {
        const row = document.getElementById('sideUploadRow');
        if (row) row.style.display = 'none';
      }
    }
  } catch {}
}

window.addEventListener('DOMContentLoaded', async ()=>{

  if (MODEL_ID){
    hideUploadsIfPreloaded()

    setLoading(true);
    try {
        await requestFront().catch(e => console.warn('Front preload falló', e));
        await requestTemple().catch(e => console.warn('Temple preload falló', e));
    } finally {
        setLoading(false);
    }
  }

});
