from flask import Blueprint, render_template, request, redirect, url_for, flash, session, Response,jsonify,current_app
from .models import Producto,Categoria,oc_product_to_category, ProductDescription,Usuario, Model
from app import db, socketio
from sqlalchemy import func
from sqlalchemy.orm import joinedload
from flask_socketio import emit
import qrcode,io
from werkzeug.security import check_password_hash
from werkzeug.utils import secure_filename
import os, random, shutil,tempfile,json,uuid
from .utils import caracterizar_lente_reducida
import numpy as np
import cv2 as cv
from pathlib import Path

main = Blueprint('main', __name__)

@main.route('/')
def index():
    return render_template('index.html')

@main.route('/catalogo')
def catalogo():
    #productos = Producto.query.all()
    # Contar productos por categoría y ordenar descendente
    categorias = (
        Categoria.query
        .options(
            joinedload(Categoria.productos).joinedload(Producto.descripcion)  # productos + descripción
        )
        .filter(Categoria.category_id.in_([107, 62, 106, 111]))
        .all()
    )
    c =[]
    for categoria in categorias:
        # Tomar los primeros 10 productos de esta categoría
        categoria.productos = categoria.productos[:10]
        c.append(categoria)
    return render_template('catalogo.html',categorias=categorias)

@main.route("/control")
def control():
    categorias = Categoria.query.filter(Categoria.category_id.in_([107, 62, 106, 111])).all()
    c =[]
    for categoria in categorias:
        # Tomar los primeros 10 productos de esta categoría
        categoria.productos = categoria.productos[:10]
        c.append(categoria)
    return render_template("control.html",categorias=categorias)


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

@main.route('/home_admin')
def home_admin():
    if 'usuario' not in session:
        flash('Debes iniciar sesión primero')
        return redirect(url_for('main.login'))

    # traemos todos los productos con su descripción
    models = Model.query.all()

    return render_template('home_admin.html', models=models)


@main.route('/logout')
def logout():
    session.pop('usuario', None)
    flash('Sesión cerrada correctamente')
    return redirect(url_for('main.login'))

def _save_upload(file_storage, subdir: str, prefix: str = "") -> str | None:
    """
    Guarda un archivo de formulario en UPLOAD_FOLDER/subdir y devuelve la ruta relativa guardada.
    Si no hay archivo, devuelve None.
    """
    if not file_storage or not getattr(file_storage, "filename", ""):
        return None

    root = current_app.config.get("UPLOAD_FOLDER", "uploads")
    base_dir = Path(root) / subdir
    base_dir.mkdir(parents=True, exist_ok=True)

    filename = secure_filename(file_storage.filename)
    # agrega un UUID corto para evitar colisiones
    stem, ext = os.path.splitext(filename)
    unique = f"{prefix}_{uuid.uuid4().hex[:8]}" if prefix else uuid.uuid4().hex[:8]
    final_name = f"{stem}_{unique}{ext}"
    path_abs = base_dir / final_name

    file_storage.save(path_abs)
    # Devolvemos ruta relativa (p.ej. para servirla estáticamente)
    return str(path_abs.as_posix())

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
            .filter(~Producto.product_id.in_(db.session.query(subq.c.product_id)))
            .order_by(ProductDescription.name.asc())
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
        polarization_info=_loads_or_none(request.form.get('polarization_info')),
        config_for_display=_loads_or_none(request.form.get('config_for_display')),
    )

    db.session.add(ar)
    db.session.commit()
    model_id = ar.model_id


    # archivos (opcionales)
    ar.path_to_img_front = _save_upload(request.files.get('path_to_img_front'), "imgs/front", prefix=str(model_id))
    ar.path_to_img_side = _save_upload(request.files.get('path_to_img_side'), "imgs/side", prefix=str(model_id))

    ar.path_to_img_front_flattened = _save_upload(request.files.get('path_to_img_front_flattened'), "imgs/flattened/front", prefix=str(model_id))
    ar.path_to_img_side_flattened = _save_upload(request.files.get('path_to_img_side_flattened'), "imgs/flattened/side", prefix=str(model_id))
    ar.path_to_img_temple_flattened = _save_upload(request.files.get('path_to_img_temple_flattened'), "imgs/flattened/temple", prefix=str(model_id))

    ar.path_to_svg_frame = _save_upload(request.files.get('path_to_svg_frame'), "svgs/frame", prefix=str(model_id))
    ar.path_to_svg_glasses = _save_upload(request.files.get('path_to_svg_glasses'), "svgs/glasses", prefix=str(model_id))
    ar.path_to_svg_temple = _save_upload(request.files.get('path_to_svg_temple'), "svgs/temple", prefix=str(model_id))

    ar.path_to_glb = _save_upload(request.files.get('path_to_glb'), "models", prefix=str(product_id))

    db.session.commit()

    flash('Modelo AR creado con éxito')
    return redirect(url_for('main.lente_detalle', lente_id=model_id))

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
    ar = Model.query.get(model_id=lente_id)
    if not ar:
        flash('Modelo no encontrado')
        return redirect(url_for('main.home_admin'))

    # Campos simples
    ar.name = request.form.get('name') or None
    ar.description = request.form.get('description') or None
    ar.visible = bool(request.form.get('visible', 'on'))

    # Archivos -> guardar y setear paths si vinieron
    ar.path_to_img_front = _save_upload(request.files.get('path_to_img_front'), "imgs/front", prefix=str(lente_id)) or ar.path_to_img_front
    ar.path_to_img_side = _save_upload(request.files.get('path_to_img_side'), "imgs/side", prefix=str(lente_id)) or ar.path_to_img_side

    ar.path_to_img_front_flattened = _save_upload(request.files.get('path_to_img_front_flattened'), "imgs/flattened/front", prefix=str(lente_id)) or ar.path_to_img_front_flattened
    ar.path_to_img_side_flattened = _save_upload(request.files.get('path_to_img_side_flattened'), "imgs/flattened/side", prefix=str(lente_id)) or ar.path_to_img_side_flattened
    ar.path_to_img_temple_flattened = _save_upload(request.files.get('path_to_img_temple_flattened'), "imgs/flattened/temple", prefix=str(lente_id)) or ar.path_to_img_temple_flattened

    ar.path_to_svg_frame = _save_upload(request.files.get('path_to_svg_frame'), "svgs/frame", prefix=str(lente_id)) or ar.path_to_svg_frame
    ar.path_to_svg_glasses = _save_upload(request.files.get('path_to_svg_glasses'), "svgs/glasses", prefix=str(lente_id)) or ar.path_to_svg_glasses
    ar.path_to_svg_temple = _save_upload(request.files.get('path_to_svg_temple'), "svgs/temple", prefix=str(lente_id)) or ar.path_to_svg_temple

    ar.path_to_glb = _save_upload(request.files.get('path_to_glb'), "models", prefix=str(lente_id)) or ar.path_to_glb

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



@main.route("/_dev/generate_fake_product_images",methods=['GET'])
def generate_fake_product_images():
    # 1) Config fuente de imágenes “semilla”
    seed_dir = os.path.join(current_app.static_folder, "images/seeds")
    pool = [os.path.join(seed_dir, f"fr{i}.png") for i in range(1, 6)]
    missing = [p for p in pool if not os.path.isfile(p)]
    if missing:
        return jsonify(error=f"Faltan semillas: {missing}"), 400

    # 2) Traer productos igual que en tu vista
    categorias = (
        Categoria.query
        .options(joinedload(Categoria.productos).joinedload(Producto.descripcion))
        .filter(Categoria.category_id.in_([107, 62, 106, 111]))
        .all()
    )
    for c in categorias:
        c.productos = c.productos[:10]

    # 3) Crear/llenar archivos en /static/<producto.image>
    overwrite = request.args.get("overwrite", "0") == "1"
    created, skipped, errors = 0, 0, []

    for categoria in categorias:
        for producto in categoria.productos:
            rel_path = (producto.image or f"catalogo/{producto.product_id}.jpg").lstrip("/\\")
            dest_path = os.path.join(current_app.static_folder, rel_path)
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)

            if os.path.exists(dest_path) and not overwrite:
                skipped += 1
                continue

            try:
                src = random.choice(pool)
                shutil.copyfile(src, dest_path)
                created += 1
            except Exception as e:
                errors.append({"producto_id": producto.product_id, "dest": rel_path, "err": str(e)})

    return jsonify(
        ok=True,
        created=created,
        skipped=skipped,
        errors=errors[:20],  # recorte por si hay muchos
        hint="Usá ?overwrite=1 para forzar reescritura."
    )


@main.route("/_dev/imgs_to_svg",methods=['GET'])
def imgs_to_svg():
    return render_template('index1.html')

@main.route("/_dev/glb_a_cara",methods=['GET'])
def glb_a_cara():
    return render_template('index2.html')

@main.route("/api/polarizar",methods=['POST'])
def api_polarizar():
    try:
        f_lente = request.files.get("lente")
        f_fondo = request.files.get("fondo")  # puede venir None
        if not f_lente:
            return jsonify({"error":"Falta archivo 'lente'"}), 400

        with tempfile.TemporaryDirectory() as td:
            p1 = os.path.join(td, secure_filename(f_lente.filename or "lente.jpg"))
            f_lente.save(p1)

            # Si no hay fondo, creamos uno blanco del tamaño del lente
            if not f_fondo:
                img_bgr = cv.imread(p1)
                if img_bgr is None:
                    return jsonify({"error":"No se pudo leer la imagen de lente"}), 400
                H, W = img_bgr.shape[:2]
                fondo_blanco = np.full((H, W, 3), 255, dtype=np.uint8)  # BGR blanco
                p2 = os.path.join(td, "fondo_blanco.jpg")
                cv.imwrite(p2, fondo_blanco)
            else:
                p2 = os.path.join(td, secure_filename(f_fondo.filename or "fondo.jpg"))
                f_fondo.save(p2)

            res = caracterizar_lente_reducida(p1, p2)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@main.route("/api/polarizar",methods=['GET'])
def api_polarizar2():
    res = caracterizar_lente_reducida('app/CENTRALBSSMK6.jpg', None)
    return jsonify(res)

