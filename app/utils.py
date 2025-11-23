from werkzeug.utils import secure_filename
import os,uuid,base64
import numpy as np
import cv2 as cv
from pathlib import Path
from flask import current_app
from .models import Model

# --- Otros helpers ---

def norm(p: str) -> str:
    if not p:
        return ""
    p = p.replace("\\", "/")      
    p = p.lstrip("/")             
    p = p.replace("uploads/", "")
    return p   


def _save_upload(file_storage, subdir: str, prefix: str = "") -> str | None:
    if not file_storage or not getattr(file_storage, "filename", ""):
        return None

    root = "uploads"
    base_dir = Path(root) / subdir
    base_dir.mkdir(parents=True, exist_ok=True)

    filename = secure_filename(file_storage.filename)
    # agrega un UUID corto para evitar colisiones
    stem, ext = os.path.splitext(filename)
    unique = f"{prefix}_{uuid.uuid4().hex[:8]}" if prefix else uuid.uuid4().hex[:8]
    final_name = f"{stem}_{unique}{ext}"
    path_abs = base_dir / final_name

    file_storage.save(path_abs)
    return str(path_abs.as_posix())


def _safe_delete(relpath: str | None):
    """Borra el archivo físico si existe. relpath es relativo a UPLOAD_FOLDER."""
    if not relpath:
        return
    # normalizo por si quedó con 'uploads/' o backslashes
    rel = relpath.replace("\\", "/").lstrip("/").replace("uploads/", "")
    full = Path(current_app.config['UPLOAD_FOLDER']) / rel
    try:
        if full.exists():
            full.unlink()
    except Exception:
        # si querés, loguealo
        pass

def _maybe_replace(request,lente_id,ar,file_key: str, subdir: str, attr: str):
    """Si vino archivo en file_key: borra el viejo ar.<attr>, guarda el nuevo y setea el path."""
    fs = request.files.get(file_key)
    if fs and getattr(fs, "filename", ""):
        _safe_delete(getattr(ar, attr))
        new_path = _save_upload(fs, subdir, prefix=str(lente_id))
        if new_path:
            setattr(ar, attr, new_path)


# --- Constantes y helpers polarizado ---
Y_COEFF = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
eps = 1e-8

def srgb_to_linear_arr(rgb01):
    a = rgb01.copy().astype(np.float32)
    low = (a <= 0.04045)
    a[low] = a[low] / 12.92
    a[~low] = ((a[~low] + 0.055) / 1.055) ** 2.4
    return a

def linear_to_srgb_arr(lin):
    a = lin.copy().astype(np.float32)
    low = (a <= 0.0031308)
    a[low] = a[low] * 12.92
    a[~low] = 1.055 * (a[~low] ** (1/2.4)) - 0.055
    return np.clip(a, 0.0, 1.0)

def to_u8(x): return (np.clip(x, 0, 1) * 255).astype(np.uint8)
def to_bool(x): return (x.astype(np.uint8) > 0)
def and_not(a, b): return np.logical_and(a, np.logical_not(b))

def cerrar_y_rellenar(mask_edges):
    k = np.ones((5,5), np.uint8)
    closed = cv.morphologyEx(mask_edges, cv.MORPH_CLOSE, k, iterations=2)
    filled = cv.morphologyEx(closed, cv.MORPH_CLOSE, np.ones((21,21), np.uint8), iterations=1)
    return (filled > 0).astype(np.uint8)

def caracterizar_lente_reducida(path_lente, path_fondo):
    img_bgr = cv.imread(path_lente)
    assert img_bgr is not None, "No se pudo leer la imagen principal."
    img_fondo_solo = cv.imread(path_fondo)
    if img_fondo_solo is None:
        alto, ancho, canales = img_bgr.shape
        img_fondo_solo = np.ones((alto, ancho, canales), dtype=np.uint8) * 255
    assert img_fondo_solo is not None, "No se pudo leer la imagen de fondo."

    # --- Segmentación lentes
    g = cv.cvtColor(img_bgr, cv.COLOR_BGR2GRAY)
    edges = cv.Canny(g, 60, 180)
    edges = cv.dilate(edges, np.ones((3,3), np.uint8), 1)
    edges = cv.morphologyEx(edges, cv.MORPH_CLOSE, np.ones((7,7), np.uint8))
    cnts, _ = cv.findContours(edges, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv.contourArea, reverse=True)

    mask_sil = np.zeros_like(g, np.uint8)
    for c in cnts[:10]:
        if cv.contourArea(c) < 800:
            continue
        cv.drawContours(mask_sil, [c], -1, 255, thickness=cv.FILLED)

    HSV = cv.cvtColor(img_bgr, cv.COLOR_BGR2HSV)
    S_img = HSV[..., 1]
    S_med_sil = float(np.median(S_img[mask_sil > 0])) if (mask_sil > 0).any() else 0.0
    es_color_o_degrade = (S_med_sil >= 35)

    num, lbl, st, _ = cv.connectedComponentsWithStats(mask_sil, 8)
    mask_int = np.zeros_like(mask_sil)
    for lb in range(1, num):
        w = st[lb, cv.CC_STAT_WIDTH]; h = st[lb, cv.CC_STAT_HEIGHT]
        r_pct = 0.05 if es_color_o_degrade else 0.09
        r = max(3, int(r_pct * min(w, h)))
        comp = (lbl == lb).astype(np.uint8) * 255
        ker  = cv.getStructuringElement(cv.MORPH_ELLIPSE, (4*r+2, 4*r+2))
        core = cv.erode(comp, ker, 1)
        mask_int = cv.bitwise_or(mask_int, core)

    mask_glass = cv.medianBlur(mask_int, 5)
    mask_glass = cv.morphologyEx(mask_glass, cv.MORPH_OPEN,  np.ones((3,3), np.uint8))
    mask_glass = cv.morphologyEx(mask_glass, cv.MORPH_CLOSE, np.ones((9,9), np.uint8))

    dist = cv.distanceTransform(mask_glass, cv.DIST_L2, 5)
    mask_geom = (dist > 2).astype(np.uint8) * 255

    mask_color  = mask_geom.copy()
    mask_lentes = mask_color.copy()

    out_lentes = cv.bitwise_and(img_bgr, cv.cvtColor(mask_lentes, cv.COLOR_GRAY2RGB))

    # --- Segmentación patillas
    img_gray = cv.cvtColor(out_lentes, cv.COLOR_BGR2GRAY)
    g = cv.GaussianBlur(img_gray, (5,5), 1.0)
    edges = cv.Canny(g, 20, 33, L2gradient=True, apertureSize=3)
    mask_glass_e= cv.erode(mask_glass, np.ones((9,9), np.uint8), 1)
    mask_patillas = cv.bitwise_and(edges,mask_glass_e)

    filled = cerrar_y_rellenar(mask_patillas)

    num, labels, stats, _ = cv.connectedComponentsWithStats(filled, connectivity=8)
    areas = stats[1:, cv.CC_STAT_AREA]
    keep = (np.argsort(areas)[::-1][:3] + 1)
    mask_out = np.isin(labels, keep).astype(np.uint8)

    mL_b = to_bool(mask_lentes)
    mO_b = to_bool(mask_out)
    mask_lentes = to_u8(and_not(mL_b, mO_b))

    # -- Estimación tinte y transmitancia global
    img_rgb01 = cv.cvtColor(img_bgr, cv.COLOR_BGR2RGB).astype(np.float32) / 255.0
    bg_rgb01  = cv.cvtColor(img_fondo_solo, cv.COLOR_BGR2RGB).astype(np.float32) / 255.0
    img_lin   = srgb_to_linear_arr(img_rgb01)
    bg_lin    = srgb_to_linear_arr(bg_rgb01)

    v_lin = np.empty_like(bg_lin)
    for c in range(3):
        v_lin[:, :, c] = cv.GaussianBlur(bg_lin[:, :, c], (0,0), sigmaX=45, sigmaY=45)
    v_lin   = np.clip(v_lin, 1e-4, None)
    img_flat = np.clip(img_lin / v_lin, 0, 1)
    bg_flat  = np.clip(bg_lin  / v_lin, 0, 1)

    HSV = cv.cvtColor(img_bgr, cv.COLOR_BGR2HSV)
    H, S, V = cv.split(HSV)
    m_pre = to_bool(mask_lentes)
    m_core = cv.erode(m_pre.astype(np.uint8), np.ones((3,3), np.uint8), 1).astype(bool)
    m_core = cv.morphologyEx(m_core.astype(np.uint8), cv.MORPH_CLOSE, np.ones((3,3), np.uint8), 1).astype(bool)
    S_in = S[m_core].astype(np.float32)
    V_in = V[m_core].astype(np.float32)
    s_thr = float(max(8.0,  np.percentile(S_in, 15)))
    v_thr = float(min(250., np.percentile(V_in, 97)))
    mask_bool = m_core & (S.astype(np.float32) >= s_thr) & (V.astype(np.float32) <= v_thr)

    MIN_PIX = 200
    if mask_bool.sum() < MIN_PIX:
        mask_bool = m_core & (S >= max(6, np.percentile(S_in, 10)))
        if mask_bool.sum() < MIN_PIX:
            mask_bool = m_core
    assert mask_bool.any(), "Máscara del vidrio sin píxeles válidos (incluso con fallback)."
    pix_bg = bg_flat[mask_bool]
    pix_th = img_flat[mask_bool]

    med_bg = np.median(pix_bg, axis=0)
    med_th = np.median(pix_th, axis=0)
    T_rgb = np.clip(med_th / (med_bg + eps), 0.0, 1.0)

    T_Y   = float(np.dot(med_th, Y_COEFF) / (np.dot(med_bg, Y_COEFF) + eps))
    T_Y   = float(np.clip(T_Y, 0.0, 1.0))
    alpha_init = float(np.clip(1.0 - T_Y, 0.02, 0.98))

    def solve_tint_for_alpha(a):
        tint = np.mean((pix_th - (1.0 - a) * pix_bg) / max(a, eps), axis=0)
        return np.clip(tint, 0.0, 1.0)

    candidatos = np.linspace(max(0.02, alpha_init - 0.30), min(0.98, alpha_init + 0.30), 31)
    best = (None, 1e9, None)
    for a in candidatos:
        tint_cand = solve_tint_for_alpha(a)
        th_hat = (1.0 - a) * pix_bg + a * tint_cand
        err = float(np.mean((pix_th - th_hat)**2))
        if err < best[1]:
            best = (a, err, tint_cand)

    alpha_glob = float(best[0])
    color_lin  = np.clip(best[2], 0.0, 1.0)
    color_srgb = linear_to_srgb_arr(color_lin)
    color_bgr_255 = (color_srgb[::-1] * 255.0).astype(np.uint8)

    # --- Perfil de degradé
    Y_th = (img_flat @ Y_COEFF).astype(np.float32)
    Y_bg = (bg_flat  @ Y_COEFF).astype(np.float32)
    T_map = np.clip(Y_th / (Y_bg + eps), 0.0, 1.0)
    m = (mask_lentes.astype(np.uint8) > 0).astype(np.uint8)
    num, lbl, stats, _ = cv.connectedComponentsWithStats(m, 8)

    cores = []
    d_core = 6
    for k in range(1, num):
        comp = (lbl == k).astype(np.uint8)
        dist = cv.distanceTransform(comp, cv.DIST_L2, 5)
        core = (dist >= d_core)
        if core.any(): cores.append(core)

    cores = [ core & (S >= s_thr) & (V <= v_thr) for core in cores ]

    H_img, W_img = T_map.shape
    MIN_PIX = 10

    def perfil_fila(mask_bool):
        perfil = np.full(H_img, np.nan, np.float32)
        for y in range(H_img):
            r = mask_bool[y]
            if r.sum() >= MIN_PIX:
                vals = T_map[y, r]
                lo, hi = np.percentile(vals, [10, 90])
                vals = vals[(vals >= lo) & (vals <= hi)]
                if vals.size:
                    perfil[y] = np.median(vals)
        return perfil

    profiles = [perfil_fila(c) for c in cores]
    if not profiles: raise ValueError("mask_lentes no tiene componentes válidas.")

    T_row = np.nanmean(np.vstack(profiles), axis=0)

    coverage = np.array([(m[y] > 0).sum() for y in range(H_img)])
    rows = np.where(coverage >= MIN_PIX)[0]
    y_min, y_max = int(rows[0]), int(rows[-1])

    idx = np.arange(H_img);ok = ~np.isnan(T_row)
    T_row = np.interp(idx, idx[ok], T_row[ok])
    T_perfil = T_row[y_min:y_max+1]
    T_perfil = T_perfil.reshape(-1,1)
    T_perfil = cv.GaussianBlur(T_perfil, (1,9), 0).ravel()
    perfil_opacidad = 1.0 - T_perfil

    alpha_rows = perfil_opacidad.copy()


    
    return {
        "alpha_glob": float(alpha_glob),
        "T_RGB": T_rgb.tolist(),
        "T_Y":T_Y,
        "tinte_BGR": color_bgr_255.tolist(),
        "alpha_rows": alpha_rows.tolist()
    }


# =========================
# === Segmentación vB  ===
# =========================
# Endpoints usados por index0_b.html para generar máscaras y SVGs en servidor,
# a partir de una imagen precargada del modelo o de un archivo subido (campo "image").

import numpy as np
import cv2 as cv
from pathlib import Path

def _imdecode_filestorage(fs):
    """Lee un FileStorage (input name='image') a np.uint8 BGR. None si no hay archivo."""
    if not fs or not getattr(fs, "filename", None):
        return None
    file_bytes = np.frombuffer(fs.read(), np.uint8)
    # IMPORTANTE: no hacer lecturas posteriores, así que no hace falta fs.seek(0)
    img = cv.imdecode(file_bytes, cv.IMREAD_COLOR)
    return img

def _imread_uploads_rel(rel_path):
    """Lee imagen desde UPLOAD_FOLDER/rel_path (o '/uploads/...') en BGR."""
    if not rel_path:
        return None
    # Aceptamos rutas que ya vengan con prefijo '/uploads/'
    if rel_path.startswith('/uploads/'):
        rel = rel_path[len('/uploads/'):]
    else:
        rel = rel_path
    root = current_app.config.get('UPLOAD_FOLDER', '')
    p = Path(root) / rel
    if not p.exists():
        return None
    return cv.imread(str(p), cv.IMREAD_COLOR)

def _load_model_image_or_upload(model_obj: Model | None,
                                primary_attr: str,
                                upload_fs,
                                fallbacks: tuple[str, ...] = ()):
    """
    Prioridad:
      1) archivo subido (campo 'image')
      2) model.<primary_attr>
      3) primeros atributos válidos en 'fallbacks'
    Devuelve BGR np.uint8 o None.
    """
    img = _imdecode_filestorage(upload_fs)
    if img is not None:
        return img
    if model_obj is not None:
        # primary
        p = getattr(model_obj, primary_attr, None)
        if p:
            img = _imread_uploads_rel(p)
            if img is not None:
                return img
        # fallbacks
        for attr in fallbacks:
            p = getattr(model_obj, attr, None)
            if p:
                img = _imread_uploads_rel(p)
                if img is not None:
                    return img
    return None

def _b64_png_dataurl(img):  # BGR o GRAY
    if img is None:
        return None
    if img.ndim == 2:
        out = img
    else:
        out = cv.cvtColor(img, cv.COLOR_BGR2RGB)
    ok, buf = cv.imencode('.png', out)
    if not ok:
        return None
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode('ascii')

def _mask_to_svg(mask_bin, fill="#000000"):
    """
    Convierte una máscara binaria (0/255) a un único <path> SVG con fill-rule="evenodd".
    Contornos externos + huecos.
    """
    h, w = mask_bin.shape[:2]
    # Asegurar 0/255
    m = (mask_bin > 0).astype(np.uint8) * 255

    # Contornos externos e internos
    contours, hierarchy = cv.findContours(m, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        # SVG vacío válido
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"></svg>'

    # Armamos un único path (evenodd) con todos los contornos
    d_parts = []
    for c in contours:
        if len(c) < 3:
            continue
        c = c.squeeze(1)  # Nx2
        xs = c[:, 0].tolist()
        ys = c[:, 1].tolist()
        d = f'M{xs[0]} {ys[0]} ' + ' '.join([f'L{xs[i]} {ys[i]}' for i in range(1, len(xs))]) + ' Z'
        d_parts.append(d)

    d_all = ' '.join(d_parts)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<path d="{d_all}" fill="{fill}" fill-rule="evenodd" stroke="none"/></svg>'
    )
    return svg

def _keep_two_largest_components(mask_bin):
    """Devuelve una máscara con sólo las dos componentes más grandes."""
    num, lbl, stats, _ = cv.connectedComponentsWithStats((mask_bin > 0).astype(np.uint8), 8, cv.CV_32S)
    if num <= 1:
        return np.zeros_like(mask_bin)
    # stats[0] = background
    areas = [(i, stats[i, cv.CC_STAT_AREA]) for i in range(1, num)]
    areas.sort(key=lambda x: x[1], reverse=True)
    keep = {i for i, _ in areas[:2]}
    out = np.zeros_like(mask_bin)
    out[np.isin(lbl, list(keep))] = 255
    return out

def _front_segmentation_vb(img_bgr, close_r=10, min_area=1200, erode_strength=1.0, dist_threshold=2.0, sat_threshold=35,
                           bottom_crop_pct=0.0, left_crop_pct=0.0, right_crop_pct=0.0, inner_adjust_px=0):
    """
    Segmentación robusta vB:
      - edges: Canny "suave" + close
      - silueta: fill de contornos externos grandes
      - interior (vidrios): erosión adaptada + distance transform
      - marco = silueta - interior
      - lentes = interior (quedarse con 2 mayores)

    Parámetros nuevos:
      - erode_strength: multiplicador de la erosión (1.0 = normal, >1 = más agresivo, <1 = menos)
      - dist_threshold: umbral del distance transform (default 2.0 px)
      - sat_threshold: umbral de saturación para decidir tipo de marco (default 35)
      - bottom_crop_pct: porcentaje inferior a eliminar (0-100%, adaptativo a la forma)
      - left_crop_pct: porcentaje lateral izquierdo a eliminar (0-50%, adaptativo)
      - right_crop_pct: porcentaje lateral derecho a eliminar (0-50%, adaptativo)
      - inner_adjust_px: ajuste del borde interior en píxeles (+ = más marco/menos lente, - = menos marco/más lente)

    Devuelve dict con máscaras y SVGs.
    """
    h, w = img_bgr.shape[:2]
    gray = cv.cvtColor(img_bgr, cv.COLOR_BGR2GRAY)

    # edges: umbrales proporcionales a histograma
    med = np.median(gray)
    low = max(0, int(0.66 * med))
    high = min(255, int(1.33 * med))
    edges = cv.Canny(gray, low, high)
    edges = cv.dilate(edges, np.ones((3, 3), np.uint8), 1)
    if close_r > 0:
        k = max(1, int(close_r))
        edges = cv.morphologyEx(edges, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_ELLIPSE, (2*k+1, 2*k+1)))

    # silueta por contornos externos
    cnts, _ = cv.findContours(edges, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    sil = np.zeros_like(gray)
    for c in cnts:
        if cv.contourArea(c) >= max(100.0, float(min_area)):
            cv.drawContours(sil, [c], -1, 255, thickness=cv.FILLED)

    if sil.max() == 0:
        # nada: devolvemos edges como guía
        return dict(
            gray=_b64_png_dataurl(gray),
            edges=_b64_png_dataurl(edges),
            sil=_b64_png_dataurl(sil),
            inner=_b64_png_dataurl(np.zeros_like(sil)),
            svg_frame=_mask_to_svg(np.zeros_like(sil)),
            svg_lenses=_mask_to_svg(np.zeros_like(sil)),
        )

    # interior vidrios: erosión adaptativa por componente
    num, lbl, st, _ = cv.connectedComponentsWithStats((sil > 0).astype(np.uint8), 8)
    inner = np.zeros_like(sil)
    HSV = cv.cvtColor(img_bgr, cv.COLOR_BGR2HSV)
    S = HSV[:, :, 1]
    for lb in range(1, num):
        comp = (lbl == lb).astype(np.uint8) * 255
        # tamaño del struct elem en función del tamaño del componente
        w_c = st[lb, cv.CC_STAT_WIDTH]
        h_c = st[lb, cv.CC_STAT_HEIGHT]
        # saturación para decidir cuánto erosionar (ahora configurable)
        med_sat = float(np.median(S[comp > 0])) if (comp > 0).any() else 0.0
        r_pct = 0.05 if med_sat >= sat_threshold else 0.09
        # Aplicar multiplicador de erosión
        r = max(3, int(r_pct * min(w_c, h_c) * erode_strength))
        ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, (4*r+2, 4*r+2))
        core = cv.erode(comp, ker, 1)
        inner = cv.bitwise_or(inner, core)

    # limpieza suave
    inner = cv.medianBlur(inner, 5)
    inner = cv.morphologyEx(inner, cv.MORPH_OPEN, np.ones((3, 3), np.uint8))
    inner = cv.morphologyEx(inner, cv.MORPH_CLOSE, np.ones((9, 9), np.uint8))

    # adelgazar bordes y quedarnos con "zonas interiores" reales (umbral configurable)
    dist = cv.distanceTransform((inner > 0).astype(np.uint8), cv.DIST_L2, 5)
    inner = (dist > dist_threshold).astype(np.uint8) * 255

    # lentes = 2 componentes más grandes
    lenses = _keep_two_largest_components(inner)

    # marco = silueta - lentes
    frame = cv.bitwise_and(sil, cv.bitwise_not(lenses))

    # Recorte inferior adaptativo (sigue la forma curva del marco)
    # IMPORTANTE: recortar columna por columna para seguir la curvatura
    if bottom_crop_pct > 0:
        crop_pct = min(100.0, max(0.0, float(bottom_crop_pct)))  # limitar entre 0-100%

        # Encontrar el bounding box del contenido (silueta)
        ys, xs = np.where(sil > 0)
        if len(ys) > 0:
            # Límites del contenido
            y_min, y_max = int(ys.min()), int(ys.max())
            content_height = y_max - y_min

            # Calcular cuántos píxeles recortar
            crop_pixels = int(content_height * (crop_pct / 100.0))

            if crop_pixels > 0:
                # Crear máscara de recorte adaptativo
                # Para cada columna, encontrar el píxel blanco más bajo y recortar desde ahí
                for x in range(w):
                    # Encontrar todos los píxeles blancos en esta columna
                    col_ys = np.where(sil[:, x] > 0)[0]

                    if len(col_ys) > 0:
                        # Píxel más bajo (mayor Y) en esta columna
                        bottom_y = int(col_ys.max())

                        # Recortar crop_pixels hacia arriba desde bottom_y
                        cut_start = max(0, bottom_y - crop_pixels)

                        # Poner en negro desde cut_start hasta bottom_y
                        frame[cut_start:bottom_y+1, x] = 0
                        lenses[cut_start:bottom_y+1, x] = 0
                        sil[cut_start:bottom_y+1, x] = 0

    # Recorte lateral izquierdo adaptativo
    if left_crop_pct > 0:
        crop_pct = min(50.0, max(0.0, float(left_crop_pct)))
        ys_l, xs_l = np.where(sil > 0)
        if len(xs_l) > 0:
            x_min = int(xs_l.min())
            x_max = int(xs_l.max())
            content_width = x_max - x_min
            crop_pixels = int(content_width * (crop_pct / 100.0))

            if crop_pixels > 0:
                for y in range(h):
                    row_xs = np.where(sil[y, :] > 0)[0]
                    if len(row_xs) > 0:
                        left_x = int(row_xs.min())
                        cut_end = min(w, left_x + crop_pixels)
                        frame[y, left_x:cut_end] = 0
                        lenses[y, left_x:cut_end] = 0
                        sil[y, left_x:cut_end] = 0

    # Recorte lateral derecho adaptativo
    if right_crop_pct > 0:
        crop_pct = min(50.0, max(0.0, float(right_crop_pct)))
        ys_r, xs_r = np.where(sil > 0)
        if len(xs_r) > 0:
            x_min = int(xs_r.min())
            x_max = int(xs_r.max())
            content_width = x_max - x_min
            crop_pixels = int(content_width * (crop_pct / 100.0))

            if crop_pixels > 0:
                for y in range(h):
                    row_xs = np.where(sil[y, :] > 0)[0]
                    if len(row_xs) > 0:
                        right_x = int(row_xs.max())
                        cut_start = max(0, right_x - crop_pixels)
                        frame[y, cut_start:right_x+1] = 0
                        lenses[y, cut_start:right_x+1] = 0
                        sil[y, cut_start:right_x+1] = 0

    # Ajuste del borde interior (marco vs lentes)
    if inner_adjust_px != 0:
        adjust = int(inner_adjust_px)
        if adjust > 0:
            # Erosionar lentes = más marco, menos lente
            kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, (2*adjust+1, 2*adjust+1))
            lenses = cv.erode(lenses, kernel, iterations=1)
        elif adjust < 0:
            # Dilatar lentes = menos marco, más lente
            kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, (2*abs(adjust)+1, 2*abs(adjust)+1))
            lenses = cv.dilate(lenses, kernel, iterations=1)

        # Recalcular marco con los lentes ajustados
        frame = cv.bitwise_and(sil, cv.bitwise_not(lenses))

    return dict(
        gray=_b64_png_dataurl(gray),
        edges=_b64_png_dataurl(edges),
        sil=_b64_png_dataurl(sil),
        inner=_b64_png_dataurl(lenses),
        frame_mask=_b64_png_dataurl(frame),  # Máscara PNG del marco para preview
        svg_frame=_mask_to_svg(frame),
        svg_lenses=_mask_to_svg(lenses)
    )

def _temple_segmentation_vb(img_bgr, close_r=7, min_area=800):
    """
    Segmentación simple/rápida de patilla.
    """
    g = cv.cvtColor(img_bgr, cv.COLOR_BGR2GRAY)
    med = np.median(g)
    low = max(0, int(0.66 * med))
    high = min(255, int(1.33 * med))
    e = cv.Canny(g, low, high)
    e = cv.dilate(e, np.ones((3, 3), np.uint8), 1)
    if close_r > 0:
        k = max(1, int(close_r))
        e = cv.morphologyEx(e, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_RECT, (2*k+1, 2*k+1)))
    # fill
    cnts, _ = cv.findContours(e, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    mask = np.zeros_like(g)
    for c in cnts:
        if cv.contourArea(c) >= max(50.0, float(min_area)):
            cv.drawContours(mask, [c], -1, 255, thickness=cv.FILLED)
    mask = cv.morphologyEx(mask, cv.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv.morphologyEx(mask, cv.MORPH_CLOSE, np.ones((11, 11), np.uint8))
    return dict(
        mask_png=_b64_png_dataurl(mask),
        svg=_mask_to_svg(mask)
    )
