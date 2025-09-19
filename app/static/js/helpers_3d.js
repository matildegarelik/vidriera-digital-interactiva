import * as THREE from "three";


const $loader = document.getElementById('loader');
export function setLoading(on){ $loader.style.display = on ? 'flex' : 'none'; }

// Coloca el pivot de una patilla en la "bisagra": extremo frontal (minX o maxX)
// side queda solo informativo; hingeEnd define qué extremo usar en ambos
export function makePivotAtHinge(group, side /* 'L' | 'R' */, hingeEnd = 'min') {
  const box = new THREE.Box3().setFromObject(group);
  const { min, max } = box;

  const xH = hingeEnd === 'max' ? max.x : min.x;   // 👈 mismo extremo para ambos
  const hinge = new THREE.Vector3(
    xH,
    (min.y + max.y) * 0.5,
    (min.z + max.z) * 0.5
  );

  // mover geometría para que la bisagra quede en (0,0,0)
  group.position.sub(hinge);

  // pivot (para rotar/posicionar) + content (para espejar solo contenido)
  const pivot = new THREE.Group();
  const content = new THREE.Group();
  content.add(group);
  pivot.add(content);
  pivot.userData.content = content;
  return pivot;
}

// Duplica SIEMPRE una patilla base en izquierda y derecha.
// Si querés que la derecha sea espejo real, poné mirrorRight:true.
export function clonePatillasAlways(baseGroup, { mirrorRight = true } = {}) {
  // Clones crudos
  const Lraw = baseGroup.clone(true);
  const Rraw = baseGroup.clone(true);

  // Recentrar cada clon (para que el cálculo de bisagra sea limpio)
  [Lraw, Rraw].forEach(g => {
    const b = new THREE.Box3().setFromObject(g);
    const c = b.getCenter(new THREE.Vector3());
    g.position.sub(c);
  });

  // Crear pivots con bisagra en origen
  const L = makePivotAtHinge(Lraw, 'L');
  const R = makePivotAtHinge(Rraw, 'R');

  // 👈 Espejo SOLO el contenido de la derecha (no el pivot)
  if (mirrorRight) {
    const content = R.userData.content;
    content.scale.x *= -1; // espejo en X
    // Con DoubleSide ya debería verse bien. Si hiciera falta:
    // content.traverse(o => { if (o.isMesh) o.material.side = THREE.DoubleSide; });
  }

  return { L, R };
}

export function saveBufferAsFile(buffer, filename) {
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Devuelve un grupo NUEVO solo con Meshes ya horneados en coordenadas de mundo.
// No quedan pivots ni grupos con transform, así el GLB abre igual que en Three.
export function bakeWorldTransforms(root) {
  const out = new THREE.Group();
  root.updateMatrixWorld(true);

  root.traverse(o => {
    if (o.isMesh && o.geometry) {
      const geom = o.geometry.clone();
      geom.applyMatrix4(o.matrixWorld);   // horneá posición/rot/escala (incluye espejo)
      geom.computeVertexNormals();

      // material clon simple (evita referencias compartidas)
      const mat = o.material && o.material.clone ? o.material.clone() : o.material;
      if (mat) mat.side = THREE.DoubleSide;

      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(0,0,0);
      mesh.rotation.set(0,0,0);
      mesh.scale.set(1,1,1);
      out.add(mesh);
    }
  });

  // El 'out' no tiene transforms relevantes; queda todo tal cual se ve.
  out.position.set(0,0,0);
  out.rotation.set(0,0,0);
  out.scale.set(1,1,1);
  return out;
}


export async function fileToDataURL(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Construye un SVG que toma la imagen y la recorta con los <path> del svg original.
// Mantiene viewBox y usa clip-rule="evenodd" para respetar agujeros del marco.
export function composeClippedImageSVG(shapeSvgText, imageHref){
  const doc = new DOMParser().parseFromString(shapeSvgText, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  let viewBox = svg?.getAttribute('viewBox');
  if(!viewBox){
    const w = parseFloat(svg?.getAttribute('width')  || '1024');
    const h = parseFloat(svg?.getAttribute('height') || '1024');
    viewBox = `0 0 ${w} ${h}`;
  }
  // Tomamos TODOS los paths (en marcos.svg suele ser 1 con evenodd + agujeros).
  const paths = [...doc.querySelectorAll('path')];
  const pathMarkup = paths.map(p=>{
    const d = p.getAttribute('d') || '';
    const fr = p.getAttribute('fill-rule') || p.getAttribute('clip-rule') || 'evenodd';
    return `<path d="${d}" fill="#000" fill-rule="${fr}" clip-rule="${fr}"/>`;
  }).join('\n');

  // El image ocupa todo el viewBox; ajustá preserveAspectRatio si querés "cover" o "stretch".
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
  <defs>
    <clipPath id="clip" clipPathUnits="userSpaceOnUse">
      ${pathMarkup}
    </clipPath>
  </defs>
  <image href="${imageHref}" x="0" y="0" width="100%" height="100%"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#clip)"/>
</svg>`;
}

export function svgTextToTexture(svgText, size=1024){
  return new Promise((resolve,reject)=>{
    const c=document.createElement('canvas'); c.width=size; c.height=size;
    const ctx=c.getContext('2d');
    const img=new Image();
    img.onload=()=>{
      ctx.clearRect(0,0,size,size);
      ctx.drawImage(img,0,0,size,size);
      const tex=new THREE.CanvasTexture(c);
      tex.colorSpace=THREE.SRGBColorSpace; tex.needsUpdate=true;
      resolve(tex);
    };
    img.onerror=reject;
    img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svgText)));
  });
}



// ----------------------- HELPERS 3D -------------------

// Genera una textura vertical (1×H) con la opacidad por fila
export function makeAlphaGradientTexture(h, alpha_rows){
  const c = document.createElement('canvas');
  c.width = 2; c.height = h;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0,0,0,h);
  for(let i=0;i<alpha_rows.length;i++){
    const t = i/(alpha_rows.length-1);
    const a = Math.max(0, Math.min(1, alpha_rows[i]));
    grd.addColorStop(t, `rgba(255,255,255,${a})`);
  }
  g.fillStyle = grd; g.fillRect(0,0,2,h);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
function clamp01(x){ return Math.min(1, Math.max(0, x)); }
export function lin2srgb(x){
  x = clamp01(x);
  return x <= 0.0031308 ? 12.92*x : 1.055 * Math.pow(x, 1/2.4) - 0.055;
}
export function bgrToHex([B,G,R]) {
  const h = v => ('0' + Math.max(0, Math.min(255, v|0)).toString(16)).slice(-2);
  return `#${h(R)}${h(G)}${h(B)}`;
  }
export function colorToInt(hex){ return parseInt(hex.replace('#','0x')); }
export function makeTintRGBAFromAlphaRows(H, tintHex, alpha_rows){
  const c = document.createElement('canvas');
  c.width = 2; c.height = H;
  const g = c.getContext('2d');

  // hex → r,g,b (0..255)
  const v = parseInt((tintHex||'#000000').replace('#',''),16) || 0;
  const r = (v>>16)&255, gg = (v>>8)&255, b = v&255;

  const img = g.createImageData(c.width, c.height);
  const A = alpha_rows, N = A.length;

  for (let y=0; y<H; y++){
    const i = Math.round((y/(H-1))*(N-1));
    const a_api = Math.max(0, Math.min(1, A[i]));  // opacidad que viene de la API
    const a = a_api * 0.3;                      // ALIVIANAR (más transparente)
    const a255 = Math.round(a * 255);

    for (let x=0; x<2; x++){
      const k = (y*2 + x)*4;
      img.data[k+0] = r;        // R
      img.data[k+1] = gg;       // G
      img.data[k+2] = b;        // B
      img.data[k+3] = a255;     // A = opacidad escalada
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
export function applyPolarMultiplyToFrontSVG({ T_RGB, T_Y, alpha_rows }){
  // 0) conseguir el <svg> del preview frontal
  const svgEl = document.querySelector('#frontPreview svg');
  if(!svgEl){ alert('No hay SVG frontal en el preview.'); return; }

  // Asegurar viewBox
  let vb = svgEl.getAttribute('viewBox');
  if(!vb){
    svgEl.setAttribute('viewBox','0 0 1000 1000');
    vb = '0 0 1000 1000';
  }
  const [vx, vy, vw, vh] = vb.split(/\s+/).map(parseFloat);

  // 1) Defs + clip con la geometría del frente
  let defs = svgEl.querySelector('defs');
  if(!defs){ defs = document.createElementNS('http://www.w3.org/2000/svg','defs'); svgEl.prepend(defs); }
  const uid = 'pol_' + Math.random().toString(36).slice(2,8);
  const clipId = `clip_${uid}`;

  const clip = document.createElementNS('http://www.w3.org/2000/svg','clipPath');
  clip.setAttribute('id', clipId);
  const geoms = svgEl.querySelectorAll('path, polygon, polyline, rect, circle, ellipse');
  if (geoms.length){
    geoms.forEach(n=>{
      const c = n.cloneNode(true);
      c.removeAttribute('stroke'); c.removeAttribute('style');
      c.setAttribute('fill','#fff');
      clip.appendChild(c);
    });
  } else {
    const r = document.createElementNS('http://www.w3.org/2000/svg','rect');
    r.setAttribute('x', vx); r.setAttribute('y', vy);
    r.setAttribute('width', vw); r.setAttribute('height', vh);
    r.setAttribute('fill', '#fff');
    clip.appendChild(r);
  }
  defs.appendChild(clip);

  // 2) Construir la "textura" 1×H con T_box[row] (lineal → sRGB)
  const H = Math.max(8, alpha_rows?.length || 256);
  const c = document.createElement('canvas');
  c.width = 1; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(1, H);

  const tyGlob = Math.max(1e-6, T_Y);
  for(let i=0;i<H;i++){
    const aRow = alpha_rows && alpha_rows[i] != null ? alpha_rows[i] : (1 - tyGlob);
    const tyRow = clamp01(1 - aRow);
    const scale = tyRow / tyGlob;
    const tLin = [
      clamp01(T_RGB[0] * scale),
      clamp01(T_RGB[1] * scale),
      clamp01(T_RGB[2] * scale),
    ];
    const Sr = lin2srgb(tLin[0])*255;
    const Sg = lin2srgb(tLin[1])*255;
    const Sb = lin2srgb(tLin[2])*255;
    const j = i*4;
    img.data[j+0] = Sr|0;
    img.data[j+1] = Sg|0;
    img.data[j+2] = Sb|0;
    img.data[j+3] = 255;   // opaco: multiply exacto → bg * T_box
  }
  g.putImageData(img, 0, 0);
  const dataURL = c.toDataURL('image/png');

  // 3) Layer multiplicativo
  //    - color varía por fila (ya codificado en la imagen)
  //    - opacity=1 para que result = bg * T (por canal)
  let overlay = svgEl.querySelector('#polarOverlay');
  if(overlay) overlay.remove();
  overlay = document.createElementNS('http://www.w3.org/2000/svg','image');
  overlay.setAttribute('id','polarOverlay');
  overlay.setAttribute('x', vx);
  overlay.setAttribute('y', vy);
  overlay.setAttribute('width', vw);
  overlay.setAttribute('height', vh);
  overlay.setAttributeNS('http://www.w3.org/1999/xlink','href', dataURL);
  overlay.setAttribute('clip-path', `url(#${clipId})`);
  overlay.setAttribute('style','mix-blend-mode:multiply; image-rendering:pixelated;');

  // Insertar al final, arriba de todo
  svgEl.appendChild(overlay);
}


export function bindExportGLB(assembled, { GLTFExporter, bakeWorldTransforms, saveBufferAsFile }){
  const btn = document.getElementById('exportGLB');
  btn.onclick = async () => {
    if (!assembled.children.length) { alert('Construí el modelo primero.'); return; }

    try {
      const exportRoot = bakeWorldTransforms(assembled);
      const exporter   = new GLTFExporter();
      const result     = await exporter.parseAsync(exportRoot, {
        binary: true,
        onlyVisible: true,
        includeCustomExtensions: true,
        forcePowerOfTwoTextures: false
      });

      if (result instanceof ArrayBuffer) {
        saveBufferAsFile(result, 'marco_completo.glb');
      } else {
        const json = JSON.stringify(result);
        const blob = new Blob([json], { type: 'model/gltf+json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'marco_completo.gltf';
        a.click();
        URL.revokeObjectURL(a.href);
        alert('Se exportó como .gltf (no .glb).');
      }
    } catch (err) {
      console.error('Export error:', err);
      alert('Error exportando GLB: ' + err);
    }
  };
}
