from flask import Blueprint, render_template

main = Blueprint('main', __name__)

@main.route('/')
def index():
    return render_template('index.html')


@main.route('/catalogo')
def catalogo():
    return render_template('catalogo.html')