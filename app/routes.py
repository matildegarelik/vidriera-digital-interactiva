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

        with open(os.path.join(os.path.dirname(__file__), 'data.json'), 'r') as f:
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
    return render_template('home_admin.html')

@main.route('/logout')
def logout():
    session.pop('usuario', None)
    flash('Sesión cerrada correctamente')
    return redirect(url_for('main.login'))

