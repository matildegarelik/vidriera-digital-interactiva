from flask import Blueprint, render_template, url_for, send_from_directory
import os
main = Blueprint('main', __name__)

#------ direcciones de los archivos ------#
BASE_DIR = os.path.dirname(os.path.abspath(__file__)) 
DATA_DIR = os.path.join(BASE_DIR, 'data') #os.path.join une los parametros en una direccion usando los \
IMAGES_DIR = os.path.join(BASE_DIR, 'images')
#----------------------------------------#

@main.route('/')
def index():
    return render_template('index.html')


@main.route('/media/<path:filename>')
def media(filename):
    return send_from_directory(IMAGES_DIR, filename)


@main.route('/catalogo/<categoria>')
def catalogo(categoria):
    productos = []

    img_dir = os.path.join(IMAGES_DIR, categoria)
    data_dir = os.path.join(DATA_DIR, categoria)
    #--------------- para las imagenes ---------------#
    #Tengo una carpeta para cada categoria, en las cuales hay carpetas para cada
    #producto llamadas prodXX (siendo XX el nro del producto). En cada carpeta la
    #imagen principal se llama main y despues si hay otras no se jaja
    if os.path.exists(img_dir):
        for prod_id in sorted(os.listdir(img_dir)):
            prod_img_dir = os.path.join(img_dir, prod_id)
            if not os.path.isdir(prod_img_dir):
                continue 
    
            #--obtengo las imagenes
            imgs = [f for f in sorted(os.listdir(prod_img_dir))
                    if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif'))]
            if not imgs:
                continue 
    
            imgs_urls = [url_for('main.media', filename=f'{categoria}/{prod_id}/{img}') for img in imgs]
    
            #--------------- para los textos ---------------#
            datos = {'nombre': prod_id, 'precio': '', 'aclaracion': '', 'descripcion': ''} #formato de los datos
            txt_path = os.path.join(data_dir, f'{prod_id}.txt')
            if os.path.exists(txt_path):
                with open(txt_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if ':' in line:
                            clave, valor = line.strip().split(':', 1)
                            datos[clave.strip()] = valor.strip()
            #--------------- creo el struct ---------------#
            productos.append({
                'id': prod_id,
                'images': imgs_urls,         # lista de URLs
                'main_img': imgs_urls[0],    # imagen principal por defecto
                'datos': datos
            })

    return render_template('catalogo.html', categoria=categoria, productos=productos)
