from flask import Blueprint,abort, render_template, request, redirect, url_for, flash, session, Response,jsonify,current_app, send_from_directory
from .models import Producto,Categoria,oc_product_to_category, ProductDescription,Usuario, Model
from app import db, socketio
from sqlalchemy import func, exists
from sqlalchemy.orm import joinedload
from flask_socketio import emit
import qrcode,io
from werkzeug.security import check_password_hash
from werkzeug.utils import secure_filename
import os, random, shutil,tempfile,json,uuid, base64
from .utils import caracterizar_lente_reducida, norm, _maybe_replace,_load_model_image_or_upload,_front_segmentation_vb,_temple_segmentation_vb
import numpy as np
import cv2 as cv
from pathlib import Path

main = Blueprint('main', __name__)

@main.route('/')
def index():
    return render_template('index.html')

@main.route('/catalogo')
def catalogo():
    # 1. Obtener categorías (sin cambios en esta parte)
    categorias = (
        db.session.query(Categoria)
        .join(oc_product_to_category, oc_product_to_category.c.category_id == Categoria.category_id)
        .join(Producto, Producto.product_id == oc_product_to_category.c.product_id)
        .join(Model, Model.product_id == Producto.product_id)
        .options(
            joinedload(Categoria.productos).joinedload(Producto.descripcion),
            joinedload(Categoria.productos).joinedload(Producto.ar_model),
        )
        .filter(Model.visible.is_(True))
        .distinct()
        .all()
    )

    # 2. Para cada categoría, quedarnos con modelos visibles Y ORDENARLOS
    for cat in categorias:
        modelos_visibles_query = [
            p.ar_model for p in cat.productos
            if p.ar_model is not None and p.ar_model.visible
        ]
        
        # --- CAMBIO AQUÍ: Ordenar usando la nueva columna ---
        modelos_ordenados = sorted(modelos_visibles_query, key=lambda m: m.sort_order)
        # --- FIN CAMBIO ---

        # Limitar
        cat.modelos = modelos_ordenados[:10]

    return render_template('catalogo.html', categorias=categorias)


@main.route('/control')
def control():
    # 1. Obtener categorías (sin cambios en esta parte)
    categorias = (
        db.session.query(Categoria)
        .join(oc_product_to_category, oc_product_to_category.c.category_id == Categoria.category_id)
        .join(Producto, Producto.product_id == oc_product_to_category.c.product_id)
        .join(Model, Model.product_id == Producto.product_id)
        .options(
            joinedload(Categoria.productos).joinedload(Producto.descripcion),
            joinedload(Categoria.productos).joinedload(Producto.ar_model),
        )
        .filter(Model.visible.is_(True))
        .distinct()
        .all()
    )

    # 2. Para cada categoría, ORDENAR
    for cat in categorias:
        modelos_visibles_query = [
            p.ar_model for p in cat.productos
            if p.ar_model is not None and p.ar_model.visible
        ]
        
        # --- CAMBIO AQUÍ: Ordenar usando la nueva columna ---
        modelos_ordenados = sorted(modelos_visibles_query, key=lambda m: m.sort_order)
        # --- FIN CAMBIO ---

        cat.modelos = modelos_ordenados[:10]

    return render_template("control.html", categorias=categorias)

@socketio.on("mover_producto")
def handle_mover_producto(data):
    # reenviamos la orden de movimiento a todos los catálogos
    emit("actualizar_producto", data, broadcast=True, include_self=False)

@socketio.on("mover_categoria")
def handle_mover_categoria(data):
    # reenviamos la orden de movimiento a todos los catálogos
    emit("actualizar_categoria", data, broadcast=True, include_self=False)
    
@main.route("/qr")
def qr():
    url = url_for('main.control',external=True)
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf)
    buf.seek(0)
    return Response(buf, mimetype="image/png")

@main.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        user = Usuario.query.filter_by(username=username).first()
        
        if user and user.password == password:  # si password está en texto plano
        # if user and check_password_hash(user.password, password):
            session['usuario'] = username
            return redirect(url_for('main.home_admin'))

        flash('Usuario o contraseña incorrectos')
        return redirect(url_for('main.login'))

    return render_template('login.html')

@main.route('/logout')
def logout():
    session.pop('usuario', None)
    flash('Sesión cerrada correctamente')
    return redirect(url_for('main.login'))

@main.route('/home_admin')
def home_admin():
    #if 'usuario' not in session:
     #   flash('Debes iniciar sesión primero')
      #  return redirect(url_for('main.login'))

    # --- CAMBIO AQUÍ ---
    # traemos todos los modelos ORDENADOS
    models = Model.query.order_by(Model.sort_order).all()
    # --- FIN CAMBIO ---

    return render_template('home_admin.html', models=models)
    
@main.route('/uploads/<path:filename>')
def uploads(filename):
    return send_from_directory(current_app.config['UPLOAD_FOLDER'], filename)

# ---------- Crear NUEVO ar_model ----------
@main.route('/lente/nuevo', methods=['GET', 'POST'])
def agregar_lente():
    if request.method == 'GET':
        # productos disponibles para asociar (sin ar_model creado aún)
        subq = db.session.query(Model.product_id).subquery()
        opciones = (
            db.session.query(
                Producto.product_id,        # pid
                Producto.model,             # pmodel
                ProductDescription.name     # dname
            )
            .join(ProductDescription, Producto.product_id == ProductDescription.product_id)
            .filter(
                exists().where(oc_product_to_category.c.product_id == Producto.product_id)
            )
            .filter(~Producto.product_id.in_(db.session.query(subq.c.product_id)))
            .order_by(func.coalesce(Producto.date_modified, Producto.date_added).desc(),
                    Producto.product_id.desc())
            .limit(100)
            .all()
        )
        return render_template('lente_nuevo.html', productos_disponibles=opciones)

    # POST: crear solo registro en ar_models
    product_id = request.form.get('product_id', type=int)
    if not product_id:
        flash('Debés seleccionar un producto válido')
        return redirect(url_for('main.agregar_lente'))

    # Evitar duplicados
    if Model.query.filter_by(product_id=product_id).first():
        flash('Este producto ya tiene un modelo AR')
        return redirect(url_for('main.lente_detalle', lente_id=product_id))

    ar = Model(
        product_id=product_id,
        visible=bool(request.form.get('visible', 'on')),
        name=request.form.get('name') or None,
        description=request.form.get('description') or None,
    )

    db.session.add(ar)
    db.session.commit()
    
    flash('Modelo AR creado con éxito')
    return redirect(url_for('main.lente_detalle', lente_id=ar.model_id))

@main.route('/lente/<int:lente_id>')
def lente_detalle(lente_id):
    ar_model = Model.query.get(lente_id)

    if not ar_model:
        flash('Modelo no encontrado')
        return redirect(url_for('main.home_admin'))

    return render_template('lente_detalle.html',ar_model=ar_model)

def _loads_or_none(texto: str):
    if not texto or not texto.strip():
        return None
    try:
        return json.loads(texto)
    except json.JSONDecodeError:
        return None

@main.route('/lente/<int:lente_id>', methods=['POST'])
def editar_lente(lente_id: int):
    ar = Model.query.get(lente_id)
    if not ar:
        flash('Modelo no encontrado')
        return redirect(url_for('main.home_admin'))
    # Campos simples
    ar.name = request.form.get('name') or None
    ar.description = request.form.get('description') or None
    ar.visible = bool(request.form.get('visible', 'on'))

    # Archivos -> si llega uno nuevo, borra el anterior y guarda el nuevo
    _maybe_replace(request,lente_id,ar, 'path_to_img_front',              "imgs/front",            'path_to_img_front')
    _maybe_replace(request,lente_id,ar, 'path_to_img_side',               "imgs/side",             'path_to_img_side')
    _maybe_replace(request,lente_id,ar, 'path_to_img_bg',                 "imgs/bg",               'path_to_img_bg')

    _maybe_replace(request,lente_id,ar, 'path_to_img_front_flattened',    "imgs/flattened/front",  'path_to_img_front_flattened')
    _maybe_replace(request,lente_id,ar, 'path_to_img_side_flattened',     "imgs/flattened/side",   'path_to_img_side_flattened')
    _maybe_replace(request,lente_id,ar, 'path_to_img_temple_flattened',   "imgs/flattened/temple", 'path_to_img_temple_flattened')
    _maybe_replace(request,lente_id,ar, 'path_to_img_bg_flattened',       "imgs/flattened/bg",     'path_to_img_bg_flattened')

    _maybe_replace(request,lente_id,ar, 'path_to_svg_frame',              "svgs/frame",            'path_to_svg_frame')
    _maybe_replace(request,lente_id,ar, 'path_to_svg_glasses',            "svgs/glasses",          'path_to_svg_glasses')
    _maybe_replace(request,lente_id,ar, 'path_to_svg_temple',             "svgs/temple",           'path_to_svg_temple')

    _maybe_replace(request,lente_id,ar, 'path_to_glb',                    "models",                'path_to_glb')

    # JSON
    ar.polarization_info = _loads_or_none(request.form.get('polarization_info'))
    ar.config_for_display = _loads_or_none(request.form.get('config_for_display'))

    db.session.commit()
    flash('Modelo actualizado con éxito')
    return redirect(url_for('main.lente_detalle', lente_id=lente_id))

@main.route('/toggle_visible/<int:lente_id>', methods=['POST'])
def toggle_visible(lente_id):
    modelo = Model.query.get(lente_id)
    if not modelo:
        return {'success': False}

    modelo.visible = not modelo.visible
    db.session.commit()

    return {'success': True, 'new_visible': modelo.visible}


@main.route('/delete_lente/<int:lente_id>', methods=['DELETE'])
def delete_lente(lente_id):
    modelo = Model.query.filter_by(model_id=lente_id).first()

    if modelo:
        db.session.delete(modelo)

    db.session.commit()
    return {'success': True}


@main.route("/_admin_helpers/aplanar_imagenes/<int:model_id>",methods=['GET','POST'])
def aplanar_imagenes(model_id):
    m = Model.query.get_or_404(model_id)

    if request.method == 'POST':
        root = current_app.config['UPLOAD_FOLDER']

        def _save_dataurl(dataurl, subdir, fname):
            if not dataurl:
                return None
            # dataurl -> bytes
            head, b64 = dataurl.split(',', 1)
            ext = '.png'
            outdir = Path(root) / subdir
            outdir.mkdir(parents=True, exist_ok=True)
            final_name = f"{fname}_{uuid.uuid4().hex[:8]}{ext}"
            outpath = outdir / final_name
            with open(outpath, 'wb') as f:
                f.write(base64.b64decode(b64))
            # devolver ruta relativa para guardar en DB
            return "/uploads/" + (Path(subdir) / final_name).as_posix()

        payload = request.get_json(silent=True) or {}
        # cada campo es un dataURL (opcional)
        f_front  = _save_dataurl(payload.get("front_flattened"),  "imgs/flattened/front",  f"front_{model_id}")
        f_side   = _save_dataurl(payload.get("side_flattened"),   "imgs/flattened/side",   f"side_{model_id}")
        f_temple = _save_dataurl(payload.get("temple_flattened"), "imgs/flattened/temple", f"temple_{model_id}")
        f_bg     = _save_dataurl(payload.get("bg_flattened"),     "imgs/flattened/bg",     f"bg_{model_id}")

        if f_front:  m.path_to_img_front_flattened  = f_front
        if f_side:   m.path_to_img_side_flattened   = f_side
        if f_temple: m.path_to_img_temple_flattened = f_temple
        if f_bg:     m.path_to_img_bg_flattened     = f_bg

        db.session.commit()
        return jsonify({
            "ok": True,
            "redirect": url_for('main.lente_detalle', lente_id=model_id)
        })


    front_img_url  = url_for('main.uploads', filename=norm(m.path_to_img_front))  if m.path_to_img_front  else ''
    side_img_url = url_for('main.uploads', filename=norm(m.path_to_img_side)) if m.path_to_img_side else ''
    bg_img_url = url_for('main.uploads', filename=norm(m.path_to_img_bg)) if m.path_to_img_bg else ''

    return render_template('helpers_admin/index_previo.html', front_img_url=front_img_url, 
                           side_img_url=side_img_url,bg_img_url=bg_img_url, model_id=model_id)

@main.route("/_admin_helpers/imgs_to_svg/<int:model_id>", methods=['GET', 'POST'])
def imgs_to_svg(model_id):
    m = Model.query.get_or_404(model_id)

    if request.method == 'POST':
        root = current_app.config['UPLOAD_FOLDER']

        def _save_fs(file_storage, subdir, fname, ext_default):
            if not file_storage:
                return None
            outdir = Path(root) / subdir
            outdir.mkdir(parents=True, exist_ok=True)
            original = secure_filename(file_storage.filename or f"{fname}{ext_default}")
            stem, ext = os.path.splitext(original)
            final_name = f"{stem}_{uuid.uuid4().hex[:8]}{ext or ext_default}"
            outpath = outdir / final_name
            file_storage.save(outpath)
            # guardar como URL pública consistente
            return "/uploads/" + (Path(subdir) / final_name).as_posix()

        # Espera 1..3 archivos (opcionales) desde el frontend
        f_frame   = _save_fs(request.files.get('svg_frame'),   "svgs/frame",   f"frame_{model_id}",   ".svg")
        f_glasses = _save_fs(request.files.get('svg_glasses'), "svgs/glasses", f"glasses_{model_id}", ".svg")
        f_temple  = _save_fs(request.files.get('svg_temple'),  "svgs/temple",  f"temple_{model_id}",  ".svg")

        if f_frame:   m.path_to_svg_frame   = f_frame
        if f_glasses: m.path_to_svg_glasses = f_glasses
        if f_temple:  m.path_to_svg_temple  = f_temple

        db.session.commit()
        return jsonify({
            "ok": True,
            "redirect": url_for('main.lente_detalle', lente_id=model_id)
        })

    # GET: pre-cargar las flattened si existen
    front_img_url  = url_for('main.uploads', filename=norm(m.path_to_img_front_flattened))  if m.path_to_img_front_flattened  else ''
    temple_img_url = url_for('main.uploads', filename=norm(m.path_to_img_temple_flattened)) if m.path_to_img_temple_flattened else ''

    return render_template(
        'helpers_admin/index0.html',
        model_id=model_id,
        front_img_url=front_img_url,
        temple_img_url=temple_img_url
    )


@main.route("/_admin_helpers/svgs_to_glb/<int:model_id>", methods=['GET', 'POST'])
def svgs_to_glb(model_id):
    m = Model.query.get_or_404(model_id)

    if request.method == 'POST':
        glb_fs = request.files.get('glb')
        if not glb_fs:
            return jsonify({"ok": False, "error": "missing_glb"}), 400

        root = current_app.config['UPLOAD_FOLDER']
        outdir = Path(root) / "models"
        outdir.mkdir(parents=True, exist_ok=True)

        original = secure_filename(glb_fs.filename or f"model_{model_id}.glb")
        stem, ext = os.path.splitext(original)
        final_name = f"{stem}_{uuid.uuid4().hex[:8]}{ext or '.glb'}"
        outpath = outdir / final_name
        glb_fs.save(outpath)

        m.path_to_glb = str(Path("models") / final_name)
        db.session.commit()

        # devolvemos a dónde ir luego
        return jsonify({
            "ok": True,
            "redirect": url_for('main.lente_detalle', lente_id=model_id)
        })

    marco_url  = url_for('main.uploads', filename=norm(m.path_to_svg_frame))   if m.path_to_svg_frame   else ''
    lentes_url = url_for('main.uploads', filename=norm(m.path_to_svg_glasses)) if m.path_to_svg_glasses else ''
    pat_url    = url_for('main.uploads', filename=norm(m.path_to_svg_temple))  if m.path_to_svg_temple  else ''
    front_img_url  = url_for('main.uploads', filename=norm(m.path_to_img_front_flattened))  if m.path_to_img_front_flattened  else ''
    temple_img_url = url_for('main.uploads', filename=norm(m.path_to_img_temple_flattened)) if m.path_to_img_temple_flattened else ''

    pol_info = m.polarization_info or '{}'

    return render_template('helpers_admin/index1.html', front_img_url=front_img_url, temple_img_url=temple_img_url, 
        marco_url=marco_url,lentes_url=lentes_url,pat_url=pat_url, polarization_info=pol_info)

@main.route('/glb-a-cara/<int:model_id>', methods=['GET', 'POST'])
def glb_a_cara(model_id):
    ar_model = Model.query.get(model_id)
    if not ar_model:
        return jsonify({"ok": False, "error": "model_not_found"}), 404

    if request.method == 'POST':
        if not ar_model:
            return jsonify({"ok": False, "error": "missing_model_id"}), 400
        data = request.get_json(silent=True, force=True) or {}
        ar_model.config_for_display = data
        db.session.commit()
        
        return jsonify({
            "ok": True,
            "redirect": url_for('main.lente_detalle', lente_id=model_id)
        })

    # GET
    return render_template('helpers_admin/index2.html', ar_model=ar_model)

@main.route("/api/polarizar/<int:model_id>",methods=['GET'])
def api_polarizar(model_id):
    m = Model.query.get_or_404(model_id)
    front_img_url  = url_for('main.uploads', filename=norm(m.path_to_img_front_flattened))  if m.path_to_img_front_flattened  else ''
    bg_img_url  = url_for('main.uploads', filename=norm(m.path_to_img_bg_flattened))  if m.path_to_img_bg_flattened  else None
    res = caracterizar_lente_reducida(front_img_url[1:], bg_img_url[1:])
    m.polarization_info= res
    db.session.commit()

    return jsonify(res)

@main.route("/_admin_helpers/api/seg_b/front", methods=['POST'])
def api_seg_b_front():
    """
    Genera máscaras (gray/edges/sil/inner) y SVG (marco/lentes) del frente.
    Parámetros (form-data):
      - close_r (int)
      - min_area (int)
      - image (File) opcional para reemplazar la precargada
    """
    close_r  = request.form.get('close_r', default=10, type=int)
    min_area = request.form.get('min_area', default=1200, type=int)
    upload_fs = request.files.get('image')
    model_id = request.form.get('model_id')

    m = Model.query.get(model_id)
    img = _load_model_image_or_upload(
        m,
        'path_to_img_front_flattened',
        upload_fs,
        fallbacks=('path_to_img_front',)
    )
    if img is None:
        return jsonify({"ok": False, "error": "no_image"}), 400

    try:
        out = _front_segmentation_vb(img, close_r=close_r, min_area=min_area)
        return jsonify({
            "ok": True,
            "masks": {
                "gray":  out["gray"],
                "edges": out["edges"],
                "sil":   out["sil"],
                "inner": out["inner"],
            },
            "svgs": {
                "frame":  out["svg_frame"],
                "lenses": out["svg_lenses"],
            }
        })
    except Exception as e:
        return jsonify({"ok": False, "error": "proc_error", "detail": str(e)}), 500

@main.route("/_admin_helpers/api/seg_b/temple/", methods=['POST'])
def api_seg_b_temple():
    """
    Genera máscara y SVG de la patilla (lateral).
    Parámetros (form-data):
      - close_r (int)
      - min_area (int)
      - image (File) opcional para reemplazar la precargada
    """
    close_r  = request.form.get('close_r', default=7, type=int)
    min_area = request.form.get('min_area', default=800, type=int)
    upload_fs = request.files.get('image')
    model_id = request.form.get('model_id')

    m = Model.query.get(model_id)
    img = _load_model_image_or_upload(
        m,
        'path_to_img_temple_flattened',
        upload_fs,
        fallbacks=('path_to_img_side_flattened', 'path_to_img_side')
    )
    if img is None:
        return jsonify({"ok": False, "error": "no_image"}), 400

    try:
        out = _temple_segmentation_vb(img, close_r=close_r, min_area=min_area)
        return jsonify({
            "ok": True,
            "masks": { "binary": out["mask_png"] },
            "svgs":  { "temple": out["svg"] }
        })
    except Exception as e:
        return jsonify({"ok": False, "error": "proc_error", "detail": str(e)}), 500

@main.route('/probar-lente/<int:model_id>')
def probar_lente(model_id: int):
    ar_model = Model.query.get_or_404(model_id)
    if not ar_model.path_to_glb:
        # Si no hay GLB cargado no tiene sentido esta vista
        abort(404, description="El modelo no tiene GLB disponible")

    return render_template('probar_lente.html', ar_model=ar_model)

@main.route('/admin/update_order', methods=['POST'])
def update_order():
    # Aquí podrías re-validar la sesión de admin si quieres
    # if 'usuario' not in session:
    #    return jsonify({'success': False, 'error': 'Unauthorized'}), 401
            
    data = request.get_json()
    model_ids = data.get('model_ids') # Esta es una lista de model_id

    if model_ids is None:
        return jsonify({'success': False, 'error': 'Missing data'}), 400

    try:
        # Actualizar el sort_order para cada modelo
        with db.session.begin_nested():
            # Creamos un mapa para actualizar en el orden recibido
            model_map = {m.model_id: m for m in Model.query.filter(Model.model_id.in_(model_ids)).all()}
            
            for index, model_id_str in enumerate(model_ids):
                model_id = int(model_id_str)
                if model_id in model_map:
                    model_map[model_id].sort_order = index
        
        db.session.commit()
        return jsonify({'success': True})

    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error updating order: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500
# --- FIN RUTA NUEVA ---
