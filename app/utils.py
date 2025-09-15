# app.py
from flask import Flask, request, jsonify

import numpy as np
import cv2 as cv


# --- Constantes y helpers mínimos ---
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
    assert img_fondo_solo is not None, "No se pudo leer la imagen de fondo."

    # --- Segmentación silueta/vidrio (igual lógica que tu base) ---
    g = cv.cvtColor(img_bgr, cv.COLOR_BGR2GRAY)
    edges = cv.Canny(g, 60, 180)
    edges = cv.dilate(edges, np.ones((3,3), np.uint8), 1)
    edges = cv.morphologyEx(edges, cv.MORPH_CLOSE, np.ones((7,7), np.uint8))
    cnts, _ = cv.findContours(edges, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv.contourArea, reverse=True)

    mask_sil = np.zeros_like(g, np.uint8)
    for c in cnts[:10]:
        if cv.contourArea(c) < 800: continue
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
    mask_lentes = mask_geom.copy()

    # --- Cálculo en espacio lineal (SIN aplanado extra) ---
    img_rgb01 = cv.cvtColor(img_bgr, cv.COLOR_BGR2RGB).astype(np.float32) / 255.0
    bg_rgb01  = cv.cvtColor(img_fondo_solo, cv.COLOR_BGR2RGB).astype(np.float32) / 255.0
    img_lin   = srgb_to_linear_arr(img_rgb01)
    bg_lin    = srgb_to_linear_arr(bg_rgb01)

    # Región robusta interior
    H, W = mask_lentes.shape
    m_pre = to_bool(mask_lentes)
    m_core = cv.erode(m_pre.astype(np.uint8), np.ones((3,3), np.uint8), 1).astype(bool)
    HSV = cv.cvtColor(img_bgr, cv.COLOR_BGR2HSV)
    Hc, Sc, Vc = cv.split(HSV)
    S_in = Sc[m_core].astype(np.float32); V_in = Vc[m_core].astype(np.float32)
    s_thr = float(max(8.0,  np.percentile(S_in, 15))) if S_in.size else 8.0
    v_thr = float(min(250., np.percentile(V_in, 97)))  if V_in.size else 250.0
    mask_bool = m_core & (Sc.astype(np.float32) >= s_thr) & (Vc.astype(np.float32) <= v_thr)
    if mask_bool.sum() < 200:  # fallback
        mask_bool = m_core

    # Transmitancias y parámetros globales
    pix_bg = bg_lin[mask_bool]
    pix_th = img_lin[mask_bool]

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
    color_hex = '#%02x%02x%02x' % tuple((color_srgb*255.0 + 0.5).astype(np.uint8))

    # --- Perfil vertical (opacidad) ---
    Y_th = (img_lin @ Y_COEFF).astype(np.float32)
    Y_bg = (bg_lin  @ Y_COEFF).astype(np.float32)
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
    if not cores:  # fallback
        cores = [m.astype(bool)]

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
    T_row = np.nanmean(np.vstack(profiles), axis=0)

    coverage = np.array([(m[y] > 0).sum() for y in range(H_img)])
    rows = np.where(coverage >= MIN_PIX)[0]
    y_min, y_max = int(rows[0]), int(rows[-1]) if rows.size else (0, H_img-1)

    idx = np.arange(H_img); ok = ~np.isnan(T_row)
    T_row = np.interp(idx, idx[ok], T_row[ok])

    T_perfil = T_row[y_min:y_max+1]
    T_perfil = cv.GaussianBlur(T_perfil.reshape(-1,1), (1,9), 0).ravel()
    alpha_rows = (1.0 - np.clip(T_perfil, 0.0, 1.0)).astype(float)

    return {
        "alpha_glob": float(alpha_glob),
        "tint_hex": color_hex,
        "y_min": int(y_min),
        "y_max": int(y_max),
        "alpha_rows": alpha_rows.tolist()
    }

