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
  // inputs
  frontFile: document.getElementById('frontFile'),
  sideFile : document.getElementById('sideFile'),
  closeR   : document.getElementById('closeR'),
  minArea  : document.getElementById('minArea'),
  erodeStrength: document.getElementById('erodeStrength'),
  distThreshold: document.getElementById('distThreshold'),
  satThreshold: document.getElementById('satThreshold'),
  bottomCrop: document.getElementById('bottomCrop'),
  leftCrop: document.getElementById('leftCrop'),
  rightCrop: document.getElementById('rightCrop'),
  innerAdjust: document.getElementById('innerAdjust'),
  closeRSide: document.getElementById('closeRSide'),
  minAreaSide: document.getElementById('minAreaSide'),
  // value displays
  closeRVal: document.getElementById('closeRVal'),
  minAreaVal: document.getElementById('minAreaVal'),
  erodeStrengthVal: document.getElementById('erodeStrengthVal'),
  distThresholdVal: document.getElementById('distThresholdVal'),
  satThresholdVal: document.getElementById('satThresholdVal'),
  bottomCropVal: document.getElementById('bottomCropVal'),
  leftCropVal: document.getElementById('leftCropVal'),
  rightCropVal: document.getElementById('rightCropVal'),
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

// Función para crear preview del marco sobre la foto (multiplicación binaria)
async function createFramePreview(photoSrc, maskSrc) {
  const canvas = document.getElementById('framePreviewCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  // Cargar imagen y máscara
  const [photo, mask] = await Promise.all([
    loadImage(photoSrc),
    loadImage(maskSrc)
  ]);

  // Configurar canvas al tamaño de la imagen
  canvas.width = photo.width;
  canvas.height = photo.height;

  // Crear canvas temporal para la máscara
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = photo.width;
  tempCanvas.height = photo.height;
  const tempCtx = tempCanvas.getContext('2d');

  // Dibujar foto en el canvas principal
  ctx.drawImage(photo, 0, 0);

  // Dibujar máscara en canvas temporal
  tempCtx.drawImage(mask, 0, 0);

  // Obtener los datos de píxeles
  const photoData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const maskData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);

  // Multiplicación binaria: foto × máscara (píxel por píxel)
  for (let i = 0; i < photoData.data.length; i += 4) {
    // La máscara es binaria: blanco (255) = mostrar, negro (0) = ocultar
    const maskValue = maskData.data[i]; // canal R de la máscara (es grayscale)

    if (maskValue === 0) {
      // Si la máscara es negra (0), poner píxel en negro
      photoData.data[i] = 0;     // R
      photoData.data[i + 1] = 0; // G
      photoData.data[i + 2] = 0; // B
      // Alpha se mantiene en 255
    }
    // Si la máscara es blanca (255), mantener el píxel de la foto
  }

  // Escribir los datos modificados de vuelta al canvas
  ctx.putImageData(photoData, 0, 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---------- FRONT: pedir al back y mostrar ----------
async function requestFront(){
  const fd = new FormData();
  fd.append('model_id', MODEL_ID ?? '');
  fd.append('close_r', ui.closeR.value);
  fd.append('min_area', ui.minArea.value);
  fd.append('erode_strength', ui.erodeStrength.value);
  fd.append('dist_threshold', ui.distThreshold.value);
  fd.append('sat_threshold', ui.satThreshold.value);
  fd.append('bottom_crop_pct', ui.bottomCrop.value);
  fd.append('left_crop_pct', ui.leftCrop.value);
  fd.append('right_crop_pct', ui.rightCrop.value);
  fd.append('inner_adjust_px', ui.innerAdjust.value);
  if (ui.frontFile.files?.[0]) fd.append('image', ui.frontFile.files[0]);

  setLoading(true);
  try{
    const j = await postFormData('/_admin_helpers/api/seg_b/front', fd);
    if (!j.ok) throw new Error('api front');

    // masks
    ui.mGray.src  = j.masks?.gray  || '';
    ui.mSil.src   = j.masks?.sil   || '';
    ui.mInner.src = j.masks?.inner || '';

    // Preview del marco con foto
    if (j.masks?.gray && j.masks?.frame_mask) {
      createFramePreview(j.masks.gray, j.masks.frame_mask).catch(e => {
        console.warn('Error creando preview del marco:', e);
      });
    }

    // svgs
    lastFrameSVG = normalizeFrameSVGWhite(j.svgs?.frame || j.svgs?.frame_svg || '');
    lastGlassSVG = (j.svgs?.lenses || j.svgs?.glass_svg || '');

    // Preview
    putSVGPreview(ui.framePrev, lastFrameSVG);
    putSVGPreview(ui.glassPrev, lastGlassSVG);
  }finally{
    setLoading(false);
  }
}
ui.btnFrontUpdate.addEventListener('click', ()=>requestFront());

// Update value displays
ui.closeR.addEventListener('input', ()=> ui.closeRVal.textContent = ui.closeR.value);
ui.minArea.addEventListener('input', ()=> ui.minAreaVal.textContent = ui.minArea.value);
ui.erodeStrength.addEventListener('input', ()=> ui.erodeStrengthVal.textContent = ui.erodeStrength.value);
ui.distThreshold.addEventListener('input', ()=> ui.distThresholdVal.textContent = ui.distThreshold.value);
ui.satThreshold.addEventListener('input', ()=> ui.satThresholdVal.textContent = ui.satThreshold.value);
ui.bottomCrop.addEventListener('input', ()=> ui.bottomCropVal.textContent = ui.bottomCrop.value);
ui.leftCrop.addEventListener('input', ()=> ui.leftCropVal.textContent = ui.leftCrop.value);
ui.rightCrop.addEventListener('input', ()=> ui.rightCropVal.textContent = ui.rightCrop.value);
ui.innerAdjust.addEventListener('input', ()=> ui.innerAdjustVal.textContent = ui.innerAdjust.value);

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
    // *** la ruta espera svg_glasses (plural) ***
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
    document.getElementById('btnFrontUpdate').click();
    document.getElementById('btnSideUpdate').click();

    setLoading(true);
    try {
        // Pedí SIEMPRE al back; si no subís archivo usa lo del modelo (con fallbacks)
        await requestFront().catch(e => console.warn('Front preload falló', e));
        await requestTemple().catch(e => console.warn('Temple preload falló', e));
    } finally {
        setLoading(false);
    }
  }
 
});

