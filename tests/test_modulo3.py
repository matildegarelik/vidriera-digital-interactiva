import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from flask import url_for # Necesario para url_for en la fixture
from app import create_app, db, socketio
from app.models import Categoria, Producto, ProductDescription, Model, Usuario, oc_product_to_category
import json
import io
from unittest.mock import patch
from pathlib import Path # Para manejar paths de forma OS-agnóstica

@pytest.fixture
def app_instance():
    """Configura la app en modo testing con una base de datos en memoria."""
    app = create_app({
        "TESTING": True,
        "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:",
        "WTF_CSRF_ENABLED": False,
        "SERVER_NAME": "localhost.test" # Necesario para url_for fuera de request
    })
    with app.app_context():
        db.create_all()

        # --- Datos de prueba ---
        cat1 = Categoria(category_id=100, sort_order=0)

        prod1 = Producto(product_id=1, model="Lente A", price=100)
        desc1 = ProductDescription(product_id=1, name="Descripcion Lente A")

        prod2 = Producto(product_id=2, model="Lente B", price=150)
        desc2 = ProductDescription(product_id=2, name="Descripcion Lente B")

        prod3 = Producto(product_id=3, model="Lente C", price=200)
        desc3 = ProductDescription(product_id=3, name="Descripcion Lente C")

        prod1.categorias.append(cat1)
        prod2.categorias.append(cat1)
        prod3.categorias.append(cat1)

        # Modelo AR 1 (completo para la mayoría de tests)
        model1 = Model(
            model_id=1,
            product_id=1,
            name="Modelo AR Lente A",
            visible=True,
            sort_order=0,
            path_to_img_front="uploads/imgs/front/front_1.png",
            # Paths para test_api_polarizar
            path_to_img_front_flattened="uploads/imgs/flattened/front/flat_front_1.png",
            path_to_img_bg_flattened="uploads/imgs/flattened/bg/flat_bg_1.png",
            path_to_glb="uploads/models/lente-a_test.glb", # Path relativo a UPLOAD_FOLDER
            config_for_display={"offsetX": 0.1}
        )

        # Modelo AR 3 (sin GLB, para test de Modulo 4)
        model3 = Model(
            model_id=3,
            product_id=3,
            name="Modelo AR Lente C",
            visible=True,
            sort_order=1,
            path_to_glb=None # Importante
        )

        admin_user = Usuario(user_id=1, username="admin", password="password")

        db.session.add_all([
            cat1, prod1, prod2, prod3, desc1, desc2, desc3,
            model1, model3, admin_user
        ])
        db.session.commit()

    return app

@pytest.fixture
def client(app_instance):
    """Cliente de prueba de Flask."""
    return app_instance.test_client()

@pytest.fixture
def logged_in_client(client):
    """Un cliente de prueba que ya ha iniciado sesión."""
    client.post('/login', data={'username': 'admin', 'password': 'password'}, follow_redirects=True)
    yield client
    client.get('/logout', follow_redirects=True) # Limpiar sesión


# --- Tests de Login ---

def test_login_page_loads(client):
    resp = client.get("/login")
    assert resp.status_code == 200
    assert b"Iniciar sesi" in resp.data

def test_login_success(client):
    resp = client.post('/login', data={
        'username': 'admin',
        'password': 'password'
    }, follow_redirects=True)
    assert resp.status_code == 200
    assert resp.request.path == '/home_admin' # Correcto: resp.request.path
    assert b"Bienvenido!" in resp.data
    assert b"Modelo AR Lente A" in resp.data

def test_login_fail(client):
    resp = client.post('/login', data={
        'username': 'admin',
        'password': 'wrongpassword'
    }, follow_redirects=True)
    assert resp.status_code == 200
    assert resp.request.path == '/login' # Correcto: resp.request.path
    assert b"Usuario o contra" in resp.data

def test_logout(logged_in_client):
    resp = logged_in_client.get('/logout', follow_redirects=True)
    assert resp.status_code == 200
    assert resp.request.path == '/login' # Correcto: resp.request.path
    assert b"Sesi" in resp.data

# --- Tests de Admin Home (Listado) ---

def test_home_admin_loads(logged_in_client):
    resp = logged_in_client.get("/home_admin")
    assert resp.status_code == 200
    assert b"Modelo AR Lente A" in resp.data
    assert b"Modelo AR Lente C" in resp.data

# --- Tests de CRUD (Crear, Editar, Borrar) ---

def test_lente_nuevo_page_loads(logged_in_client):
    resp = logged_in_client.get("/lente/nuevo")
    assert resp.status_code == 200
    assert b"Lente B" in resp.data
    assert b"Lente A" not in resp.data

def test_lente_nuevo_post(logged_in_client, app_instance):
    resp = logged_in_client.post("/lente/nuevo", data={
        "product_id": 2,
        "name": "Nuevo Modelo Test",
        "description": "Descrip",
        "visible": "on"
    }, follow_redirects=True)

    assert resp.status_code == 200
    # No verificamos flash message porque la plantilla no lo muestra

    with app_instance.app_context():
        new_model = db.session.scalar(db.select(Model).filter_by(product_id=2))
        assert new_model is not None
        assert new_model.name == "Nuevo Modelo Test"
        assert new_model.visible == True
        # Verificar redirección a la página del nuevo modelo
        assert resp.request.path == f"/lente/{new_model.model_id}"

def test_lente_detalle_page_loads(logged_in_client):
    resp = logged_in_client.get("/lente/1")
    assert resp.status_code == 200
    assert b"Editar Modelo AR #1" in resp.data
    assert b'value="Modelo AR Lente A"' in resp.data

def test_lente_editar_post(logged_in_client, app_instance):
    resp = logged_in_client.post("/lente/1", data={
        "name": "Nombre Actualizado",
        "description": "Descrip Actualizada",
        "visible": "on"
    }, follow_redirects=True)

    assert resp.status_code == 200
    # No verificamos flash message
    assert resp.request.path == "/lente/1" # Verificar redirección

    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model.name == "Nombre Actualizado"

def test_toggle_visible(logged_in_client, app_instance):
    with app_instance.app_context():
        assert db.session.get(Model, 1).visible == True

    resp = logged_in_client.post("/toggle_visible/1")
    data = json.loads(resp.data)

    assert resp.status_code == 200
    assert data["success"] == True
    assert data["new_visible"] == False

    with app_instance.app_context():
        assert db.session.get(Model, 1).visible == False

def test_delete_lente(logged_in_client, app_instance):
    resp = logged_in_client.delete("/delete_lente/1")
    data = json.loads(resp.data)

    assert resp.status_code == 200
    assert data["success"] == True

    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model is None

# --- Tests de Orden y Helpers ---

def test_update_order(logged_in_client, app_instance):
    resp = logged_in_client.post("/admin/update_order", json={
        "model_ids": ["3", "1"] # IDs como strings, como los envía el JS
    })
    data = json.loads(resp.data)

    assert resp.status_code == 200
    assert data["success"] == True

    with app_instance.app_context():
        assert db.session.get(Model, 1).sort_order == 1
        assert db.session.get(Model, 3).sort_order == 0

def test_admin_helper_pages_load(logged_in_client):
    resp_aplanar = logged_in_client.get("/_admin_helpers/aplanar_imagenes/1")
    assert resp_aplanar.status_code == 200

    resp_svg = logged_in_client.get("/_admin_helpers/imgs_to_svg/1")
    assert resp_svg.status_code == 200

    resp_glb = logged_in_client.get("/_admin_helpers/svgs_to_glb/1")
    assert resp_glb.status_code == 200

    resp_cara = logged_in_client.get("/glb-a-cara/1")
    assert resp_cara.status_code == 200

# --- Tests de Guardado de Admin Helpers ---

def test_helper_glb_a_cara_post(logged_in_client, app_instance):
    config_data = {
        "offsetX": 0.5, "offsetY": -0.1, "widthFactor": 2.5, "extraScale": 1.1
    }
    resp = logged_in_client.post("/glb-a-cara/1", json=config_data)
    data = json.loads(resp.data)

    assert resp.status_code == 200
    assert data["ok"] == True

    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model.config_for_display is not None
        assert model.config_for_display["offsetX"] == 0.5
        assert model.config_for_display["widthFactor"] == 2.5

@patch('app.routes.caracterizar_lente_reducida')
def test_api_polarizar(mock_caracterizar, logged_in_client, app_instance):
    # Asegurarse que el modelo tiene las imágenes necesarias en la fixture
    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model.path_to_img_front_flattened is not None
        assert model.path_to_img_bg_flattened is not None

    mock_caracterizar.return_value = {"type": "polarizado", "angle": 90}

    resp = logged_in_client.get("/api/polarizar/1")
    # Check for potential errors during request processing
    if resp.status_code != 200:
        print("Error response data:", resp.data.decode()) # Print error details
    assert resp.status_code == 200

    data = json.loads(resp.data)
    assert data["type"] == "polarizado"

    # Verificar que se guardó en la DB
    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model.polarization_info is not None
        assert model.polarization_info["angle"] == 90

def test_helper_svgs_to_glb_post(logged_in_client, app_instance):
    mock_glb_data = b'mock glb content'
    data = {'glb': (io.BytesIO(mock_glb_data), 'test_model.glb')}

    resp = logged_in_client.post(
        "/_admin_helpers/svgs_to_glb/1",
        data=data,
        content_type='multipart/form-data'
    )
    resp_data = json.loads(resp.data)

    assert resp.status_code == 200
    assert resp_data["ok"] == True

    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model.path_to_glb is not None
        # Usar pathlib para comparación OS-agnóstica
        p = Path(model.path_to_glb)
        assert p.parent.name == "models"
        assert p.name.startswith("test_model_")
        assert p.name.endswith(".glb")

def test_helper_aplanar_imagenes_post(logged_in_client, app_instance):
    mock_dataurl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHCgJ/pUfLrwAAAABJRU5ErkJggg=="
    payload = {
        "front_flattened": mock_dataurl,
        "temple_flattened": mock_dataurl
    }

    resp = logged_in_client.post("/_admin_helpers/aplanar_imagenes/1", json=payload)
    resp_data = json.loads(resp.data)

    assert resp.status_code == 200
    assert resp_data["ok"] == True

    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model.path_to_img_front_flattened is not None
        assert model.path_to_img_temple_flattened is not None
        assert model.path_to_img_front_flattened.endswith(".png")
        # Verificar que el path contiene la estructura esperada (OS-agnóstico)
        assert Path(model.path_to_img_front_flattened).parts[-3:-1] == ('imgs', 'flattened', 'front')

def test_helper_imgs_to_svg_post(logged_in_client, app_instance):
    mock_svg_data = b'<svg></svg>'
    data = {
        'svg_frame': (io.BytesIO(mock_svg_data), 'frame.svg'),
        'svg_glasses': (io.BytesIO(mock_svg_data), 'glasses.svg')
    }

    resp = logged_in_client.post(
        "/_admin_helpers/imgs_to_svg/1",
        data=data,
        content_type='multipart/form-data'
    )
    resp_data = json.loads(resp.data)

    assert resp.status_code == 200
    assert resp_data["ok"] == True

    with app_instance.app_context():
        model = db.session.get(Model, 1)
        assert model.path_to_svg_frame is not None
        assert model.path_to_svg_glasses is not None
        assert model.path_to_svg_frame.endswith(".svg")
        assert Path(model.path_to_svg_frame).parts[-2:] == ('svgs', 'frame')