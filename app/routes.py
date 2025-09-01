from flask import Blueprint, render_template, request, redirect, url_for, flash, session, Response,jsonify,current_app
from .models import Producto,Categoria,oc_product_to_category, ProductDescription,Usuario
from app import db, socketio
from sqlalchemy import func
from sqlalchemy.orm import joinedload
from flask_socketio import emit
import qrcode,io
from werkzeug.security import check_password_hash
import os, random, shutil

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

@socketio.on("cambiar_producto")
def handle_cambio(data):
    # reenviar a todos los catálogos conectados
    print('tesxt')
    emit("actualizar_catalogo", data, broadcast=True, include_self=True)

@socketio.on("mover_catalogo")
def handle_mover_catalogo(data):
    # reenviamos la orden de movimiento a todos los catálogos
    emit("mover_catalogo", data, broadcast=True, include_self=False)

@socketio.on("mover_categoria")
def handle_mover_categoria(data):
    # reenviamos la orden de movimiento a todos los catálogos
    emit("mover_categoria", data, broadcast=True, include_self=False)
    
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
    categoria_ids = [107, 62, 106, 111]
    lentes = []

    for cat_id in categoria_ids:
        productos = (
            db.session.query(Producto, ProductDescription)
            .join(ProductDescription, Producto.product_id == ProductDescription.product_id)
            .join(oc_product_to_category, Producto.product_id == oc_product_to_category.c.product_id)
            .filter(oc_product_to_category.c.category_id == cat_id)
            .limit(10)
            .all()
        )
        lentes.extend(productos)

    # armamos lista simple para la plantilla
    lentes_data = [
        {
            "id": p.product_id,
            "nombre": desc.name,
            "imagen": p.image,
            "visible": p.status
        }
        for p, desc in lentes
    ]

    return render_template('home_admin.html', lentes=lentes_data)


@main.route('/logout')
def logout():
    session.pop('usuario', None)
    flash('Sesión cerrada correctamente')
    return redirect(url_for('main.login'))


@main.route('/lente/<int:lente_id>')
def lente_detalle(lente_id):
    lente = (
        db.session.query(Producto, ProductDescription)
        .join(ProductDescription, Producto.product_id == ProductDescription.product_id)
        .filter(Producto.product_id == lente_id)
        .first()
    )

    if not lente:
        flash('Modelo no encontrado')
        return redirect(url_for('main.home_admin'))

    p, desc = lente
    return render_template('lente_detalle.html', lente={
        "id": p.product_id,
        "nombre": desc.name,
        "imagen": p.image,
        "visible": p.status
    })


@main.route('/lente/<int:lente_id>', methods=['POST'])
def editar_lente(lente_id):
    producto = Producto.query.get(lente_id)
    descripcion = ProductDescription.query.filter_by(product_id=lente_id).first()

    if not producto or not descripcion:
        flash('Modelo no encontrado')
        return redirect(url_for('main.home_admin'))

    descripcion.name = request.form['nombre']
    producto.image = request.form['imagen']
    producto.status = 'visible' in request.form

    db.session.commit()

    flash('Modelo actualizado con éxito')
    return redirect(url_for('main.lente_detalle', lente_id=lente_id))


@main.route('/toggle_visible/<int:lente_id>', methods=['POST'])
def toggle_visible(lente_id):
    producto = Producto.query.get(lente_id)
    if not producto:
        return {'success': False}

    producto.status = not producto.status
    db.session.commit()

    return {'success': True, 'new_visible': producto.status}


@main.route('/delete_lente/<int:lente_id>', methods=['DELETE'])
def delete_lente(lente_id):
    producto = Producto.query.get(lente_id)
    descripcion = ProductDescription.query.filter_by(product_id=lente_id).first()

    if producto:
        db.session.delete(producto)
    if descripcion:
        db.session.delete(descripcion)

    db.session.commit()
    return {'success': True}


@main.route('/lente/nuevo', methods=['GET', 'POST'])
def agregar_lente():
    if request.method == 'POST':
        nuevo_producto = Producto(
            model=request.form['nombre'],
            image=request.form['imagen'],
            status='visible' in request.form,
            quantity=0,  # defaults, cambialo según tu modelo
            price=0
        )
        db.session.add(nuevo_producto)
        db.session.commit()

        nueva_desc = ProductDescription(
            product_id=nuevo_producto.product_id,
            name=request.form['nombre']
        )
        db.session.add(nueva_desc)
        db.session.commit()

        flash('Modelo agregado con éxito')
        return redirect(url_for('main.home_admin'))

    return render_template('lente_nuevo.html')



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
