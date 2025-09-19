// Pequeños helpers locales (copias livianas para debug visual)
export  const canvasFrom=(src,w,h)=>{ const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(src,0,0,w,h); return c; };
export  const toGray=(src)=>{ const c=canvasFrom(src,src.width,src.height), ctx=c.getContext('2d'), im=ctx.getImageData(0,0,c.width,c.height);
    for(let i=0;i<im.data.length;i+=4){ const r=im.data[i],g=im.data[i+1],b=im.data[i+2]; const y=(0.299*r+0.587*g+0.114*b)|0; im.data[i]=im.data[i+1]=im.data[i+2]=y; im.data[i+3]=255; }
    ctx.putImageData(im,0,0); return c; };
export    const otsu=(gray)=>{ const ctx=gray.getContext('2d'), im=ctx.getImageData(0,0,gray.width,gray.height); const h=new Uint32Array(256); let tot=gray.width*gray.height; for(let i=0;i<im.data.length;i+=4) h[im.data[i]]++;
    let sum=0; for(let i=0;i<256;i++) sum+=i*h[i]; let sumB=0,wB=0,max=-1,t=127; for(let i=0;i<256;i++){ wB+=h[i]; if(!wB) continue; const wF=tot-wB; if(!wF) break; sumB+=i*h[i]; const mB=sumB/wB,mF=(sum-sumB)/wF; const between=wB*wF*(mB-mF)*(mB-mF); if(between>max){max=between;t=i;} } return t; };
export   const thresh=(gray,t)=>{ const c=canvasFrom(gray,gray.width,gray.height), ctx=c.getContext('2d'), im=ctx.getImageData(0,0,c.width,c.height);
    for(let i=0;i<im.data.length;i+=4){ const v=im.data[i]<=t?0:255; im.data[i]=im.data[i+1]=im.data[i+2]=v; im.data[i+3]=255; } ctx.putImageData(im,0,0); return c; };
export  const andWithComplementB = (A, B) => {
    const w = A.width, h = A.height;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const oa = out.getContext('2d');
    const ia = A.getContext('2d').getImageData(0, 0, w, h);
    const ib = B.getContext('2d').getImageData(0, 0, w, h);
    const oo = oa.createImageData(w, h);

    // Función para erosión (mínimo en la vecindad de 3x3)
    const erosion = (imageData) => {
        const eroded = new Uint8Array(imageData.data.length);
        for (let i = 0; i < imageData.data.length; i += 4) {
            // Obtener la coordenada de la celda en la imagen
            const x = (i / 4) % w;
            const y = Math.floor(i / 4 / w);

            // Verificar si el píxel actual está dentro de la imagen y es blanco
            if (imageData.data[i] === 255) {
                let erode = true;
                // Comprobar la vecindad de 3x3
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            const ni = ((ny * w) + nx) * 4;
                            if (imageData.data[ni] !== 255) {
                                erode = false;
                                break;
                            }
                        }
                    }
                    if (!erode) break;
                }
                eroded[i] = erode ? 255 : 0;
            } else {
                eroded[i] = 0;
            }
            eroded[i + 1] = eroded[i + 2] = eroded[i];  // R, G, B son iguales
            eroded[i + 3] = 255;  // Alpha siempre a 255
        }
        return eroded;
    };

    // Función para dilución (máximo en la vecindad de 3x3)
    const dilation = (imageData) => {
        const dilated = new Uint8Array(imageData.data.length);
        for (let i = 0; i < imageData.data.length; i += 4) {
            const x = (i / 4) % w;
            const y = Math.floor(i / 4 / w);
            
            let dilate = false;
            // Comprobar la vecindad de 3x3
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                        const ni = ((ny * w) + nx) * 4;
                        if (imageData.data[ni] === 255) {
                            dilate = true;
                            break;
                        }
                    }
                }
                if (dilate) break;
            }

            dilated[i] = dilate ? 255 : 0;
            dilated[i + 1] = dilated[i + 2] = dilated[i];  // R, G, B son iguales
            dilated[i + 3] = 255;  // Alpha siempre a 255
        }
        return dilated;
    };

    // Primero, realizamos la operación AND con el complemento de B
    for (let i = 0; i < oo.data.length; i += 4) {
        const a = ia.data[i] < 128 ? 0 : 255;
        const b = ib.data[i] < 128 ? 0 : 255;
        const bComplement = b === 0 ? 255 : 0;

        // Operación AND entre A y el complemento de B
        const v = a & bComplement ? 255 : 0;

        oo.data[i] = oo.data[i + 1] = oo.data[i + 2] = v;
        oo.data[i + 3] = 255; // Alpha (opacidad) siempre a 255 (totalmente opaco)
    }

    // Aplicamos la erosión y luego la dilución (Apertura Binaria)
    const erodedData = erosion(oo);
    const dilatedData = dilation({ data: erodedData, width: w, height: h });

    // Ponemos los datos dilatados en la imagen de salida
    for (let i = 0; i < oo.data.length; i += 4) {
        oo.data[i] = dilatedData[i];
        oo.data[i + 1] = dilatedData[i + 1];
        oo.data[i + 2] = dilatedData[i + 2];
        oo.data[i + 3] = dilatedData[i + 3];  // Alpha
    }

    oa.putImageData(oo, 0, 0);
    return out;
};

// --- Helpers binarios sobre canvas ---
export const binFromCanvas = (c) => {
    const w=c.width,h=c.height, d=c.getContext('2d').getImageData(0,0,w,h).data;
    const b=new Uint8Array(w*h);
    for(let i=0,j=0;i<d.length;i+=4,j++) b[j] = d[i] >= 128 ? 1 : 0; // 1=blanco
    return {b,w,h};
  };
export const toCanvasFromBin = ({b,w,h})=>{
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const im=c.getContext('2d').createImageData(w,h);
    for(let i=0,j=0;j<b.length;i+=4,j++){ const v=b[j]*255; im.data[i]=im.data[i+1]=im.data[i+2]=v; im.data[i+3]=255; }
    c.getContext('2d').putImageData(im,0,0); return c;
  };

  // Labeling 4-conexo y top-2 por área
  // Conserva sólo las 2 componentes conexas más grandes (4-conexo)
  const keepTwoLargestCC = ({ b, w, h }) => {
    const lab = new Int32Array(w * h).fill(-1);
    const areas = [];
    let cur = 0;

    // Recorremos toda la imagen binaria (1 = blanco)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (b[idx] === 1 && lab[idx] === -1) {
          // --- BFS para esta componente ---
          const qx = new Int32Array(w * h);
          const qy = new Int32Array(w * h);
          let head = 0, tail = 0;

          const push = (px, py) => { qx[tail] = px; qy[tail] = py; tail++; };
          const pop  = () => { const px = qx[head], py = qy[head]; head++; return { x: px, y: py }; };

          push(x, y);
          lab[idx] = cur;
          let area = 0;

          while (head < tail) {
            const { x: px, y: py } = pop();
            area++;

            // 4 vecinos
            const N = [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]];
            for (const [nx, ny] of N) {
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const n = ny * w + nx;
              if (b[n] === 1 && lab[n] === -1) {
                lab[n] = cur;
                push(nx, ny);
              }
            }
          }
          areas.push(area);
          cur++;
        }
      }
    }

    // Tomar índices de las 2 mayores áreas (o menos si no hay 2)
    const keepIdx =
      areas
        .map((a, i) => [a, i])
        .sort((A, B) => B[0] - A[0])
        .slice(0, 2)
        .map((x) => x[1]);

    const out = new Uint8Array(w * h);
    for (let i = 0; i < lab.length; i++) {
      if (keepIdx.includes(lab[i])) out[i] = 1;
    }
    return { b: out, w, h };
  };

  // Elemento estructurante circular de radio r
  const seOffsets = (r)=>{
    const offs=[]; const r2=r*r;
    for(let dy=-r; dy<=r; dy++) for(let dx=-r; dx<=r; dx++)
      if(dx*dx+dy*dy <= r2) offs.push([dx,dy]);
    return offs;
  };
  const dilate = ({b,w,h}, offs)=>{
    const out=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let v=0;
      for(const [dx,dy] of offs){
        const nx=x+dx, ny=y+dy;
        if(nx>=0&&ny>=0&&nx<w&&ny<h && b[ny*w+nx]===1){ v=1; break; }
      }
      out[y*w+x]=v;
    }
    return {b:out,w,h};
  };
  const erode = ({b,w,h}, offs)=>{
    const out=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let v=1;
      for(const [dx,dy] of offs){
        const nx=x+dx, ny=y+dy;
        if(!(nx>=0&&ny>=0&&nx<w&&ny<h) || b[ny*w+nx]!==1){ v=0; break; }
      }
      out[y*w+x]=v;
    }
    return {b:out,w,h};
  };
  const closing = (bin, r=12)=>{
    const offs = seOffsets(r);
    return erode(dilate(bin, offs), offs);
  };

  // Relleno de huecos (0-regiones no conectadas al borde)
  const fillHoles = ({b,w,h})=>{
    const vis=new Uint8Array(w*h);
    const qx=new Int32Array(w*h), qy=new Int32Array(w*h);
    let head=0, tail=0;
    const push=(x,y)=>{ const k=tail++; qx[k]=x; qy[k]=y; };
    const flood=(sx,sy)=>{
      head=tail=0; push(sx,sy); vis[sy*w+sx]=1;
      while(head<tail){
        const x=qx[head], y=qy[head++], N=[[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
        for(const [nx,ny] of N){
          if(nx<0||ny<0||nx>=w||ny>=h) continue;
          const i=ny*w+nx;
          if(!vis[i] && b[i]===0){ vis[i]=1; push(nx,ny); }
        }
      }
    };
    for(let x=0;x<w;x++){ if(b[x]===0&&!vis[x]) flood(x,0); if(b[(h-1)*w+x]===0&&!vis[(h-1)*w+x]) flood(x,h-1); }
    for(let y=0;y<h;y++){ const i=y*w; if(b[i]===0&&!vis[i]) flood(0,y); const j=y*w+(w-1); if(b[j]===0&&!vis[j]) flood(w-1,y); }
    const out=new Uint8Array(w*h);
    for(let i=0;i<b.length;i++) out[i] = b[i]===1 ? 1 : (vis[i]?0:1);
    return {b:out,w:h?h:0,h};
  };

  // --- Pipeline específico para tus lentes en XOR ---
export const fillTwoBiggestAndClose = (xorCanvas, radius=14, doFillHoles=true)=>{
    let bin = binFromCanvas(xorCanvas);
    bin = keepTwoLargestCC(bin);              // 1) dos blobs grandes
    bin = closing(bin, radius);               // 2) cerrar mordidas de patillas
    if(doFillHoles) bin = fillHoles(bin);     // 3) por si queda algún hueco
    return toCanvasFromBin(bin);
  };

