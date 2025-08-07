from flask import Blueprint, render_template, request, redirect, url_for, flash, session
import json
import os

main = Blueprint('main', __name__)

@main.route('/')
def index():
    return render_template('index.html')

@main.route('/catalogo')
def catalogo():
    return render_template('catalogo.html')

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

