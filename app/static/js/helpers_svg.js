import * as THREE from "three";
window.rebuildIfPossible ??= () => {};
import { fillTwoBiggestAndClose } from './helpers_morph.js';

const $loader = document.getElementById('loader');
export function setLoading(on){ $loader.style.display = on ? 'flex' : 'none'; }


// --- Utils raster ---
function canvasFrom(imgOrCanvas, w, h){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.drawImage(imgOrCanvas, 0,0, w,h);
  return c;
}

function toGrayCanvas(src){
  const c = canvasFrom(src, src.width, src.height);
  const ctx = c.getContext('2d'); const im = ctx.getImageData(0,0,c.width,c.height);
  for (let i=0;i<im.data.length;i+=4){
    const r=im.data[i], g=im.data[i+1], b=im.data[i+2];
    const y = (0.299*r + 0.587*g + 0.114*b)|0;
    im.data[i]=im.data[i+1]=im.data[i+2]=y; im.data[i+3]=255;
  }
  ctx.putImageData(im,0,0); return c;
}

function thresholdCanvas(gray, thr){ // thr: 0..255
  const c = canvasFrom(gray, gray.width, gray.height);
  const ctx = c.getContext('2d'); const im = ctx.getImageData(0,0,c.width,c.height);
  for (let i=0;i<im.data.length;i+=4){
    const v = im.data[i] <= thr ? 0 : 255;
    im.data[i]=im.data[i+1]=im.data[i+2]=v; im.data[i+3]=255;
  }
  ctx.putImageData(im,0,0); return c;
}
function canvasAND(A, B){
  const w=A.width, h=A.height;
  const out=document.createElement('canvas'); out.width=w; out.height=h;
  const ia=A.getContext('2d').getImageData(0,0,w,h).data;
  const ib=B.getContext('2d').getImageData(0,0,w,h).data;
  const io=out.getContext('2d').createImageData(w,h);
  for(let i=0;i<ia.length;i+=4){
    const v = (ia[i] >= 128 && ib[i] >= 128) ? 255 : 0;
    io.data[i]=io.data[i+1]=io.data[i+2]=v; io.data[i+3]=255;
  }
  out.getContext('2d').putImageData(io,0,0);
  return out;
}
function canvasNOT(A){
  const w=A.width, h=A.height;
  const out=document.createElement('canvas'); out.width=w; out.height=h;
  const ia=A.getContext('2d').getImageData(0,0,w,h).data;
  const io=out.getContext('2d').createImageData(w,h);
  for(let i=0;i<ia.length;i+=4){
    const v = ia[i] >= 128 ? 0 : 255; // invierte
    io.data[i]=io.data[i+1]=io.data[i+2]=v; io.data[i+3]=255;
  }
  out.getContext('2d').putImageData(io,0,0);
  return out;
}



function otsuThreshold(gray){
  const ctx = gray.getContext('2d'); const im = ctx.getImageData(0,0,gray.width,gray.height);
  const hist = new Uint32Array(256); let total = gray.width*gray.height;
  for (let i=0;i<im.data.length;i+=4){ hist[im.data[i]]++; }
  let sum=0; for (let i=0;i<256;i++) sum += i*hist[i];
  let sumB=0, wB=0, max=-1, t=127;
  for (let i=0;i<256;i++){
    wB += hist[i]; if(!wB) continue;
    const wF = total - wB; if(!wF) break;
    sumB += i*hist[i];
    const mB = sumB/wB, mF = (sum - sumB)/wF;
    const between = wB*wF*(mB-mF)*(mB-mF);
    if (between>max){ max=between; t=i; }
  }
  return t;
}

// --- SVG/path helpers ---
function svgPathsD(svgText){
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  return Array.from(doc.querySelectorAll('path')).map(p=>p.getAttribute('d')||'');
}

function pathsToFilledCanvas(ds, w, h, evenodd=true){
  const c = document.createElement('canvas'); c.width=w; c.height=h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0,0,w,h); // negro fondo
  ctx.save();
  const p2d = new Path2D();
  ds.forEach(d=>{ try{ p2d.addPath(new Path2D(d)); }catch{} });
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff';
  ctx.fill(p2d, evenodd ? 'evenodd' : 'nonzero');
  ctx.restore();
  return c;
}

function xorInside(a, b, mask){ // a,b,mask: binarios (0/255)
  const w=a.width,h=a.height;
  const out = document.createElement('canvas'); out.width=w; out.height=h;
  const oa = out.getContext('2d');
  const ia = a.getContext('2d').getImageData(0,0,w,h);
  const ib = b.getContext('2d').getImageData(0,0,w,h);
  const im = mask.getContext('2d').getImageData(0,0,w,h);
  const oo = oa.createImageData(w,h);
  for (let i=0;i<oo.data.length;i+=4){
    const A = ia.data[i]   <128 ? 0:255;
    const B = ib.data[i]   <128 ? 0:255;
    const M = im.data[i]   <128 ? 255:0;
    const v = M ? ((A^B)?255:0) : 0; // XOR dentro de la máscara
    oo.data[i]=oo.data[i+1]=oo.data[i+2]=v; oo.data[i+3]=255;
  }
  oa.putImageData(oo,0,0); return out;
}

function vectorizeBinaryCanvasToSVG(binCanvas){
  const imgdata = ImageTracer.getImgdata(binCanvas);
  return ImageTracer.imagedataToSVG(imgdata, { numberofcolors: 2, ltres: 1.0, pathomit: 6, scale: 1 });
}

function pickLargestNPaths(svgText, w, h, n=2){
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.style.position='absolute'; svg.style.left='-99999px'; svg.style.top='-99999px';
  document.body.appendChild(svg);
  const items = [];
  for (const p of Array.from(doc.querySelectorAll('path'))){
    const d = p.getAttribute('d')||''; if(!d) continue;
    const el = document.createElementNS('http://www.w3.org/2000/svg','path');
    el.setAttribute('d', d); svg.appendChild(el);
    const bb = el.getBBox(); svg.removeChild(el);
    items.push({ d, a: bb.width*bb.height, cx: bb.x + bb.width/2 });
  }
  document.body.removeChild(svg);
  items.sort((a,b)=>b.a-a.a);
  return items.slice(0,n).map(it=>it.d);
}

// --- MORFOLOGÍA SOBRE CANVAS BINARIO (255/0) ---
function _binFromCanvas(c){
  const w=c.width, h=c.height;
  const d=c.getContext('2d').getImageData(0,0,w,h).data;
  const b=new Uint8Array(w*h);
  for(let i=0,j=0;i<d.length;i+=4,j++) b[j] = d[i] >= 128 ? 1 : 0;
  return {b,w,h};
}
function _canvasFromBin({b,w,h}){
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const im=c.getContext('2d').createImageData(w,h);
  for(let i=0,j=0;j<b.length;i+=4,j++){
    const v=b[j]?255:0; im.data[i]=im.data[i+1]=im.data[i+2]=v; im.data[i+3]=255;
  }
  c.getContext('2d').putImageData(im,0,0); return c;
}
function _seOffsets(r){
  const o=[]; const r2=r*r;
  for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++)
    if(dx*dx+dy*dy<=r2) o.push([dx,dy]);
  return o;
}
function _dilate({b,w,h}, offs){
  const out=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let v=0;
    for(const [dx,dy] of offs){
      const nx=x+dx, ny=y+dy;
      if(nx>=0&&ny>=0&&nx<w&&ny<h && b[ny*w+nx]){ v=1; break; }
    }
    out[y*w+x]=v;
  }
  return {b:out,w,h};
}
function _erode({b,w,h}, offs){
  const out=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let v=1;
    for(const [dx,dy] of offs){
      const nx=x+dx, ny=y+dy;
      if(!(nx>=0&&ny>=0&&nx<w&&ny<h) || !b[ny*w+nx]){ v=0; break; }
    }
    out[y*w+x]=v;
  }
  return {b:out,w,h};
}
function closingCanvas(binCanvas, radius=6){
  const bin=_binFromCanvas(binCanvas);
  const offs_e=_seOffsets(Math.max(1, radius|0));
  const offs_d=_seOffsets(Math.max(1, (Math.trunc(radius / 2)+1)|0));
  return _canvasFromBin(_erode(_dilate(bin, offs_e),offs_e));
}


// ---------- FOTO → SVG (ImageTracer) ----------
function vectorizeFromFile(file, { mode='outline', ltres=1.0, pathomit=8, ncolors=2 }) {
  return new Promise((resolve, reject) => {
    if (!file) return reject('No file');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // dibujar en canvas (¡clave para evitar getContext undefined!)
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const optsOutline = { ltres: parseFloat(ltres), pathomit: parseInt(pathomit), numberofcolors: 2, scale:1 };
      const optsFew     = { ltres: parseFloat(ltres), pathomit: parseInt(pathomit), numberofcolors: parseInt(ncolors), scale:1 };
      const opts = (mode === 'fewcolors') ? optsFew : optsOutline;

      const imgData = ImageTracer.getImgdata(canvas);
      const svg = ImageTracer.imagedataToSVG(imgData, opts);
      URL.revokeObjectURL(url);
      resolve({svg,canvas});
    };
    img.onerror = reject;
    img.src = url;
  });
}

function applyPreviewStyle(svgText, { stroke = 'none', strokeWidth = 0, fill = '#ffffff', bg = '#000' } = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.documentElement;

  // viewBox razonable
  if (!svgEl.getAttribute('viewBox')) {
    let w = parseFloat(svgEl.getAttribute('width') || '1000');
    let h = parseFloat(svgEl.getAttribute('height') || '1000');
    svgEl.setAttribute('viewBox', `0 0 ${w||1000} ${h||1000}`);
  }
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');
  svgEl.setAttribute('width', '100%');
  svgEl.setAttribute('height', '100%');
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Fondo (rect) para que el blanco se vea
  if (bg) {
    const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
    rect.setAttribute('width', '100%'); rect.setAttribute('height', '100%');
    rect.setAttribute('fill', bg);
    svgEl.insertBefore(rect, svgEl.firstChild);
  }

  // Forzar estilos en shapes
  svgEl.querySelectorAll('path, polygon, polyline, rect, circle, ellipse').forEach(el => {
    el.removeAttribute('style');         // evita estilos heredados del tracer
    el.setAttribute('fill', fill);       // RELLENO
    el.setAttribute('stroke', stroke);   // sin borde
    el.setAttribute('stroke-width', String(strokeWidth));
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
  });

  return new XMLSerializer().serializeToString(svgEl);
}

// Devuelve { frameSVG, glassSVG } replicando tu flujo de Inkscape.
function splitFrontByDualThresholdXOR(srcCanvas, {outerDelta=+20, innerDelta=-25} = {}){
  // 1) escala base (usamos tamaño de la foto)
  const W = srcCanvas.width, H = srcCanvas.height;

  // 2) gris + Otsu
  const gray = toGrayCanvas(srcCanvas);
  const tOtsu = otsuThreshold(gray);
  const tOuter = Math.min(255, Math.max(0, tOtsu + outerDelta)); // marco “sólido”
  const tInner = Math.min(255, Math.max(0, tOtsu + innerDelta)); // más permisivo

  // 3) binarios
  const binOuter = thresholdCanvas(gray, tOuter); // marco
  const binInner = thresholdCanvas(gray, tInner); // incluye bordes internos (anillos)

  // 4) vectorizar OUTER y dibujar su máscara llena (para evitar agujeros)
  const svgOuter = vectorizeBinaryCanvasToSVG(binOuter);
  const outerDs  = pickLargestNPaths(svgOuter, W, H, 1); // el contorno grande
  const outerMask = pathsToFilledCanvas(outerDs, W, H, /*evenodd*/true);

  // 5) XOR dentro del marco → bordes interiores (anillos / límites de vidrio)
  const ringBin = xorInside(binInner, binOuter, outerMask);

  // 6) vectorizar XOR y quedarnos con los 2 anillos grandes (izq/der)
  const radius = parseInt(document.getElementById('closingRadius')?.value ?? 60);
  const doFill = document.getElementById('chkFillHoles')?.checked ?? true;

  // 6) Cerrar patillas y rellenar huecos → máscara de lentes "final"
  const lensCanvas = fillTwoBiggestAndClose(ringBin, radius, doFill);

  // 7) Vectorizar directamente esa máscara para LENTES (lo que ves en "Resultado procesado")
  const glassSVG = vectorizeBinaryCanvasToSVG(lensCanvas);

  // Marco = INNER ∧ ¬LENTES  (usa la máscara de arriba a la derecha)
  const marcoCanvas = canvasAND(canvasNOT(binInner), canvasNOT(lensCanvas));
  const frameSVG = vectorizeBinaryCanvasToSVG(marcoCanvas);

  return { frameSVG, glassSVG, binOuter, binInner, lensCanvas,marcoCanvas };

}



function downloadTextAs(name, text, mime='image/svg+xml') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- UI FOTO→SVG ----------
export const front = {
  photo: document.getElementById('frontPhoto'),
  mode: document.getElementById('frontMode'),
  ltres: document.getElementById('frontLtres'),
  pathomit: document.getElementById('frontPathomit'),
  ncolors: document.getElementById('frontNcolors'),
  toSVG: document.getElementById('frontToSVG'),
  download: document.getElementById('frontDownload'),
  stroke: document.getElementById('frontStroke'),
  strokeW: document.getElementById('frontStrokeW'),
  fill: document.getElementById('frontFill'),

  framePreview: document.getElementById('frontFramePreview'),
  glassPreview: document.getElementById('frontGlassPreview'),
  downloadFrame: document.getElementById('frontDownloadFrame'),
  downloadGlass: document.getElementById('frontDownloadGlass'),
  text: '', // SVG crudo
  frameText: '',     //  marco solo
  glassText: ''      // lentes solo
};

export const side = {
  photo: document.getElementById('sidePhoto'),
  mode: document.getElementById('sideMode'),
  ltres: document.getElementById('sideLtres'),
  pathomit: document.getElementById('sidePathomit'),
  ncolors: document.getElementById('sideNcolors'),
  toSVG: document.getElementById('sideToSVG'),
  download: document.getElementById('sideDownload'),
  stroke: document.getElementById('sideStroke'),
  strokeW: document.getElementById('sideStrokeW'),
  fill: document.getElementById('sideFill'),
  preview: document.getElementById('sidePreview'),
  text: ''
};

function refreshPreview(which){
  const stroke = which.stroke?.value ?? '#ffffff';
  const strokeWidth = parseFloat(which.strokeW?.value ?? '2');
  const fill = which.fill?.value ?? 'none';

  if (which === front){
    setPreviewHTML(front.framePreview, front.frameText, { stroke, strokeWidth, fill });
    setPreviewHTML(front.glassPreview, front.glassText, { stroke, strokeWidth, fill });
  } else {
    // side
    if (which.preview && which.text){
      setPreviewHTML(which.preview, which.text, { stroke, strokeWidth, fill });
    }
  }
}

function setPreviewHTML(container, svgText, { stroke, strokeWidth, fill }){
  if (!container) return;
  if (!svgText) { container.innerHTML = ''; return; }
  const styled = applyPreviewStyle(svgText, { stroke, strokeWidth, fill });
  container.innerHTML = styled;
}

if (front.toSVG) front.toSVG.onclick = async ()=>{
  const f = front.photo.files?.[0];
  if(!f){ alert('Cargá imagen o SVG frontal'); return; }
  setLoading(true);
  try{
    let isSVG = (f.type.includes('svg') || /\.svg$/i.test(f.name));
    let srcCanvas = null;

    if (isSVG) {
      front.text = await f.text();
      front.tex  = null;
    } else {
      const { svg, canvas } = await vectorizeFromFile(f, {
        mode: front.mode.value,
        ltres: front.ltres.value,
        pathomit: front.pathomit.value,
        ncolors: front.ncolors.value
      });
      front.text = svg;
      front.tex  = new THREE.CanvasTexture(canvas);
      front.tex.colorSpace = THREE.SRGBColorSpace;
      front.tex.needsUpdate = true;
      srcCanvas = canvas;          // 👈 usamos la foto original escalada
    }

    // Si el usuario subió SVG directo, igual usamos un canvas de respaldo
    if (!srcCanvas) {
      // generar canvas desde el propio SVG renderizado a tamaño del viewBox
      const tmp = document.createElement('canvas');
      tmp.width  = 1000; tmp.height = 1000;
      const ctx = tmp.getContext('2d');
      const img = new Image();
      const svg64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(front.text)));
      await new Promise((res,rej)=>{ img.onload=()=>res(); img.onerror=rej; img.src=svg64; });
      ctx.drawImage(img,0,0,1000,1000);
      srcCanvas = tmp;
    }

    const od = parseInt(document.getElementById('thrOuterDelta')?.value ?? 20);
    const id = parseInt(document.getElementById('thrInnerDelta')?.value ?? -25);

    const { frameSVG, glassSVG, binOuter, binInner, lensCanvas, marcoCanvas } =splitFrontByDualThresholdXOR(srcCanvas, { outerDelta: od, innerDelta: id });

    front.frameText = frameSVG;
    front.glassText = glassSVG;

    front._marcoCanvas = marcoCanvas;
    front._lentesCanvas = lensCanvas;

    const cvOuter = document.getElementById('maskOuter');
    const cvInner = document.getElementById('maskInner');
    const cvXor   = document.getElementById('maskXor');

    [cvOuter, cvInner, cvXor].forEach(c => { c.width = srcCanvas.width; c.height = srcCanvas.height; });
    cvOuter.getContext('2d').drawImage(binOuter, 0, 0);
    cvInner.getContext('2d').drawImage(binInner, 0, 0);
    cvXor.getContext('2d').drawImage(lensCanvas, 0, 0);

    // previews Marco/Lentes
    refreshPreview(front);

  } catch(e){
    alert('Error al procesar frente: ' + e.message);
  } finally {
    setLoading(false);
  }
};


if (side.toSVG) side.toSVG.onclick = async ()=>{
  const f = side.photo.files?.[0];
  if(!f){ alert('Cargá imagen o SVG de patilla'); return; }
  setLoading(true);
  try{
    if (f.type.includes('svg') || /\.svg$/i.test(f.name)) {
      side.text = await f.text();
      side.tex  = null;
    } else {
      const mode     = side.mode?.value ?? 'outline';
      const ltres    = parseFloat(side.ltres?.value ?? '1.0');
      const pathomit = parseInt(side.pathomit?.value ?? '8');
      const ncolors  = parseInt(side.ncolors?.value ?? '2');

      const { svg, canvas } = await vectorizeFromFile(f, {
        mode, ltres, pathomit, ncolors
      });

      side.text = svg;
      side.tex  = new THREE.CanvasTexture(canvas);
      side.tex.colorSpace = THREE.SRGBColorSpace;
      side.tex.needsUpdate = true;
    }

    refreshPreview(side);
  } catch(e){
    alert('Error al procesar patilla: ' + e.message);
  } finally {
    setLoading(false);
  }
};


[front.stroke, front.strokeW, front.fill].filter(Boolean).forEach(el=>el.addEventListener('input', ()=>{
  refreshPreview(front);
  const stroke = front.stroke?.value ?? '#ffffff';
  const strokeWidth = parseFloat(front.strokeW?.value ?? '2');
  const fill = front.fill?.value ?? 'none';
  setPreviewHTML(front.framePreview, front.frameText, { stroke, strokeWidth, fill });
  setPreviewHTML(front.glassPreview, front.glassText, { stroke, strokeWidth, fill });
}));

[side.stroke, side.strokeW, side.fill].filter(Boolean).forEach(el=>el.addEventListener('input', ()=>refreshPreview(side)));

// Deja sólo las figuras blancas y quita cualquier fondo
function keepWhiteOnlyNoBG(svg){
  // 1) quitar <rect> de fondo (full size)
  svg = svg.replace(/<rect[^>]*width="100%".*?<\/rect>/gis, '');
  // 2) eliminar shapes negros
  svg = svg
    .replace(/fill\s*=\s*"(?:#000000|#000|black)"/gi, 'fill="__DROP__"')
    .replace(/stroke\s*=\s*"(?:#000000|#000|black)"/gi, 'stroke="__DROP__"');
  svg = svg.replace(/<([^>]+)\s+(?:[^>]*)(?:fill="__DROP__"[^>]*)[^>]*>/gi, (m, tag)=>{
    // si la figura queda sin fill útil, la eliminamos completa
    return /\/>$/.test(m) ? '' : '';
  });
  // 3) asegurar blanco en las figuras restantes
  svg = svg
    .replace(/fill\s*=\s*"(?:#ffffff|#fff|white)"/gi, 'fill="#ffffff"')
    .replace(/stroke\s*=\s*"(?:#ffffff|#fff|white)"/gi, 'stroke="#ffffff"');
  // 4) quitar width/height para que sea responsive y sin fondo
  svg = svg.replace(/\swidth="[^"]*"/i, '').replace(/\sheight="[^"]*"/i, '');
  return svg;
}

// Marco
if (front.downloadFrame) {
  front.downloadFrame.onclick = () => {
    if (front._marcoCanvas) {
      const svgRaw = vectorizeBinaryCanvasToSVG(front._marcoCanvas);
      const svg = keepWhiteOnlyNoBG(svgRaw);
      downloadTextAs('frente_marco.svg', svg);
    } else if (front.frameText) {
      downloadTextAs('frente_marco.svg', keepWhiteOnlyNoBG(front.frameText));
    }
  };
}

// Lentes
if (front.downloadGlass) {
  front.downloadGlass.onclick = () => {
    if (front._lentesCanvas) {
      const svgRaw = vectorizeBinaryCanvasToSVG(front._lentesCanvas);
      const svg = keepWhiteOnlyNoBG(svgRaw);
      downloadTextAs('frente_lentes.svg', svg);
    } else if (front.glassText) {
      downloadTextAs('frente_lentes.svg', keepWhiteOnlyNoBG(front.glassText));
    }
  };
}

// Patilla (si querés mismo criterio)
if (side.download) {
  side.download.onclick = ()=>{ if(side.text) downloadTextAs('patilla.svg', keepWhiteOnlyNoBG(side.text)); };
}
