from flask import Blueprint, render_template, request, redirect, url_for, flash, session, Response
import json
import os
from .models import Producto,Categoria,oc_product_to_category
from app import db
from sqlalchemy import func
from sqlalchemy.orm import joinedload
from flask_socketio import emit
from . import socketio  # 👈 importo socketio desde __init__.py
import qrcode
import io


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
    emit("actualizar_catalogo", data, broadcast=True)

@main.route("/qr")
def qr():
    url = url_for('main.control',external=True)
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(buf, mimetype="image/png")


@main.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        with open(os.path.join(os.path.dirname(__file__), 'usuarios.json'), 'r') as f:
            usuarios = json.load(f)

        for u in usuarios:
            if u['username'] == username and u['password'] == password:
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
    
    with open(os.path.join(os.path.dirname(__file__), 'lentes.json'), 'r') as f:
        lentes = json.load(f)

    return render_template('home_admin.html', lentes=lentes)

@main.route('/logout')
def logout():
    session.pop('usuario', None)
    flash('Sesión cerrada correctamente')
    return redirect(url_for('main.login'))

@main.route('/lente/<int:lente_id>')
def lente_detalle(lente_id):
    with open(os.path.join(os.path.dirname(__file__), 'lentes.json'), 'r') as f:
        lentes = json.load(f)

    lente = next((l for l in lentes if l['id'] == lente_id), None)

    if not lente:
        flash('Modelo no encontrado')
        return redirect(url_for('main.home_admin'))

    return render_template('lente_detalle.html', lente=lente)

@main.route('/lente/<int:lente_id>', methods=['POST'])
def editar_lente(lente_id):
    path = os.path.join(os.path.dirname(__file__), 'lentes.json')
    with open(path, 'r') as f:
        lentes = json.load(f)

    for lente in lentes:
        if lente['id'] == lente_id:
            lente['nombre'] = request.form['nombre']
            lente['imagen'] = request.form['imagen']
            lente['visible'] = 'visible' in request.form
            break

    with open(path, 'w') as f:
        json.dump(lentes, f, indent=4)

    flash('Modelo actualizado con éxito')
    return redirect(url_for('main.lente_detalle', lente_id=lente_id))


@main.route('/toggle_visible/<int:lente_id>', methods=['POST'])
def toggle_visible(lente_id):
    path = os.path.join(os.path.dirname(__file__), 'lentes.json')
    with open(path, 'r') as f:
        lentes = json.load(f)

    for lente in lentes:
        if lente['id'] == lente_id:
            lente['visible'] = not lente['visible']
            break

    with open(path, 'w') as f:
        json.dump(lentes, f, indent=4)

    return {'success': True, 'new_visible': lente['visible']}

@main.route('/delete_lente/<int:lente_id>', methods=['DELETE'])
def delete_lente(lente_id):
    path = os.path.join(os.path.dirname(__file__), 'lentes.json')
    with open(path, 'r') as f:
        lentes = json.load(f)

    lentes = [l for l in lentes if l['id'] != lente_id]

    with open(path, 'w') as f:
        json.dump(lentes, f, indent=4)

    return {'success': True}

@main.route('/lente/nuevo', methods=['GET', 'POST'])
def agregar_lente():
    if request.method == 'POST':
        path = os.path.join(os.path.dirname(__file__), 'lentes.json')
        with open(path, 'r') as f:
            lentes = json.load(f)

        nuevo_id = max([l['id'] for l in lentes], default=0) + 1

        nuevo_lente = {
            'id': nuevo_id,
            'nombre': request.form['nombre'],
            'imagen': request.form['imagen'],
            'visible': 'visible' in request.form
        }

        lentes.append(nuevo_lente)

        with open(path, 'w') as f:
            json.dump(lentes, f, indent=4)

        flash('Modelo agregado con éxito')
        return redirect(url_for('main.home_admin'))

    return render_template('lente_nuevo.html')

