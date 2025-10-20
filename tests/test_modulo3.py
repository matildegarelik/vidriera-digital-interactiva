import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from flask import url_for
from urllib.parse import urlparse
from app import create_app, db, socketio
from app.models import Categoria, Producto, ProductDescription, Model, Usuario, oc_product_to_category
import json
import io
from unittest.mock import patch
from pathlib import Path
import decimal

# --- Fixture ---
@pytest.fixture
def app_instance():
    app = create_app({
        "TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:",
        "WTF_CSRF_ENABLED": False, "SERVER_NAME": "localhost.test"
    })
    with app.app_context():
        db.create_all()
        cat1 = Categoria(category_id=100, sort_order=0)
        prod1 = Producto(product_id=1, model="Lente A", price=decimal.Decimal("100.50"))
        desc1 = ProductDescription(product_id=1, name="Descripcion Lente A")
        prod2 = Producto(product_id=2, model="Lente B", price=150)
        desc2 = ProductDescription(product_id=2, name="Descripcion Lente B")
        prod3 = Producto(product_id=3, model="Lente C", price=200)
        desc3 = ProductDescription(product_id=3, name="Descripcion Lente C")
        prod1.categorias.append(cat1); prod2.categorias.append(cat1); prod3.categorias.append(cat1)
        model1 = Model(
            model_id=1, product_id=1, name="Modelo AR Lente A",
            description="Desc Original", visible=True, sort_order=0,
            path_to_img_front="uploads/imgs/front/front_1.png",
            path_to_img_front_flattened="uploads/imgs/flattened/front/flat_front_1.png",
            path_to_img_bg_flattened="uploads/imgs/flattened/bg/flat_bg_1.png",
            path_to_glb="uploads/models/lente-a_test.glb",
            config_for_display={"offsetX": 0.1}, polarization_info={"type": "standard"}
        )
        model3 = Model(model_id=3, product_id=3, name="Modelo AR Lente C", visible=True, sort_order=1)
        admin_user = Usuario(user_id=1, username="admin", password="password")
        db.session.add_all([cat1, prod1, prod2, prod3, desc1, desc2, desc3, model1, model3, admin_user])
        db.session.commit()
    return app

@pytest.fixture
def client(app_instance): return app_instance.test_client()

@pytest.fixture
def logged_in_client(client):
    client.post('/login', data={'username': 'admin', 'password': 'password'}, follow_redirects=True)
    yield client
    client.get('/logout', follow_redirects=True)

# --- Tests Login / Logout / Home --- 
def test_login_page_loads(client):
    resp = client.get("/login")
    assert resp.status_code == 200 and b"Iniciar sesi" in resp.data
def test_login_success(client):
    resp = client.post('/login', data={'username': 'admin', 'password': 'password'}, follow_redirects=True)
    assert resp.status_code == 200 and resp.request.path == '/home_admin' and b"Bienvenido!" in resp.data
def test_login_fail(client):
    resp = client.post('/login', data={'username': 'admin', 'password': 'wrongpassword'}, follow_redirects=True)
    assert resp.status_code == 200 and resp.request.path == '/login' and b"Usuario o contra" in resp.data
def test_logout(logged_in_client):
    resp = logged_in_client.get('/logout', follow_redirects=True)
    assert resp.status_code == 200 and resp.request.path == '/login' and b"Sesi" in resp.data
def test_home_admin_loads(logged_in_client):
    resp = logged_in_client.get("/home_admin")
    assert resp.status_code == 200 and b"Modelo AR Lente A" in resp.data

# --- Tests CRUD ---
def test_lente_nuevo_page_loads(logged_in_client):
    resp = logged_in_client.get("/lente/nuevo")
    assert resp.status_code == 200 and b"Lente B" in resp.data and b"Lente A" not in resp.data
def test_lente_nuevo_post(logged_in_client, app_instance):
    resp = logged_in_client.post("/lente/nuevo", data={"product_id": 2, "name": "Nuevo Modelo Test", "description": "Descrip", "visible": "on"}, follow_redirects=True)
    assert resp.status_code == 200
    with app_instance.app_context():
        new_model = db.session.scalar(db.select(Model).filter_by(product_id=2))
        assert new_model and new_model.name == "Nuevo Modelo Test" and resp.request.path == f"/lente/{new_model.model_id}"

# --- Tests Detail/Model Split --- 
def test_lente_detalle_page_loads(logged_in_client):
    resp = logged_in_client.get("/lente/1")
    assert resp.status_code == 200 and b"Editar producto" in resp.data and b'name="name"' in resp.data and b'value="detalle"' in resp.data and b'name="polarization_info"' not in resp.data
def test_lente_editar_post_from_detalle(logged_in_client, app_instance):
    resp = logged_in_client.post("/lente/1", data={"name": "Nombre Actualizado Detalle", "description": "Descrip Actualizada", "price": "110.99", "visible": "on", "from_page": "detalle"}, follow_redirects=True)
    assert resp.status_code == 200 and resp.request.path == "/lente/1"
    with app_instance.app_context(): assert db.session.get(Model, 1).name == "Nombre Actualizado Detalle"
def test_lente_modelo_page_loads(logged_in_client):
    resp = logged_in_client.get("/lente_modelo/1")
    assert resp.status_code == 200 and b"Im\xc3\xa1genes originales" in resp.data and b'name="polarization_info"' in resp.data and b'value="modelo"' in resp.data and b'name="name"' not in resp.data
def test_lente_editar_post_from_modelo(logged_in_client, app_instance):
    new_polarization_data = '{"type": "updated", "angle": 45}'
    resp = logged_in_client.post("/lente/1", data={"polarization_info": new_polarization_data, "from_page": "modelo"}, follow_redirects=True)
    assert resp.status_code == 200 and resp.request.path == "/lente_modelo/1"
    with app_instance.app_context(): assert db.session.get(Model, 1).polarization_info["type"] == "updated"

# --- Tests Toggle/Delete/Order ---
def test_toggle_visible(logged_in_client, app_instance):
    with app_instance.app_context(): assert db.session.get(Model, 1).visible == True
    resp = logged_in_client.post("/toggle_visible/1"); data = json.loads(resp.data)
    assert resp.status_code == 200 and data["success"] == True and data["new_visible"] == False
    with app_instance.app_context(): assert db.session.get(Model, 1).visible == False
def test_delete_lente(logged_in_client, app_instance):
    resp = logged_in_client.delete("/delete_lente/1"); data = json.loads(resp.data)
    assert resp.status_code == 200 and data["success"] == True
    with app_instance.app_context(): assert db.session.get(Model, 1) is None
def test_update_order(logged_in_client, app_instance):
    resp = logged_in_client.post("/admin/update_order", json={"model_ids": ["3", "1"]}); data = json.loads(resp.data)
    assert resp.status_code == 200 and data["success"] == True
    with app_instance.app_context(): assert db.session.get(Model, 1).sort_order == 1; assert db.session.get(Model, 3).sort_order == 0

# --- Tests Helper Pages Load ---
def test_admin_helper_pages_load(logged_in_client):
    assert logged_in_client.get("/_admin_helpers/aplanar_imagenes/1").status_code == 200
    assert logged_in_client.get("/_admin_helpers/imgs_to_svg/1").status_code == 200
    assert logged_in_client.get("/_admin_helpers/svgs_to_glb/1").status_code == 200
    assert logged_in_client.get("/glb-a-cara/1").status_code == 200

# --- Tests Helper POSTs --- 
def test_helper_glb_a_cara_post(logged_in_client, app_instance):
    config_data = {"offsetX": 0.5, "offsetY": -0.1, "widthFactor": 2.5, "extraScale": 1.1}
    resp = logged_in_client.post("/glb-a-cara/1", json=config_data)
    data = json.loads(resp.data)
    assert resp.status_code == 200 and data["ok"] == True
    with app_instance.app_context():
        expected_url = url_for('main.lente_detalle', lente_id=1)
        expected_path = urlparse(expected_url).path # Extraer path
        assert data["redirect"] == expected_path   # Comparar paths
        model = db.session.get(Model, 1)
        assert model.config_for_display["offsetX"] == 0.5

@patch('app.routes.caracterizar_lente_reducida')
def test_api_polarizar(mock_caracterizar, logged_in_client, app_instance):
    with app_instance.app_context(): assert db.session.get(Model, 1).path_to_img_front_flattened
    mock_caracterizar.return_value = {"type": "polarizado", "angle": 90}
    resp = logged_in_client.get("/api/polarizar/1")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["type"] == "polarizado"
    with app_instance.app_context(): assert db.session.get(Model, 1).polarization_info["angle"] == 90

def test_helper_svgs_to_glb_post(logged_in_client, app_instance):
    mock_glb_data = b'mock glb content'
    data = {'glb': (io.BytesIO(mock_glb_data), 'test_model.glb')}
    resp = logged_in_client.post("/_admin_helpers/svgs_to_glb/1", data=data, content_type='multipart/form-data')
    resp_data = json.loads(resp.data)
    assert resp.status_code == 200 and resp_data["ok"] == True
    with app_instance.app_context():
        expected_url = url_for('main.lente_modelo', lente_id=1)
        expected_path = urlparse(expected_url).path # Extraer path
        assert resp_data["redirect"] == expected_path # Comparar paths
        model = db.session.get(Model, 1)
        assert model.path_to_glb is not None
        p = Path(model.path_to_glb); assert p.parent.name == "models" and p.name.startswith("test_model_")

def test_helper_aplanar_imagenes_post(logged_in_client, app_instance):
    mock_dataurl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHCgJ/pUfLrwAAAABJRU5ErkJggg=="
    payload = {"front_flattened": mock_dataurl, "temple_flattened": mock_dataurl}
    resp = logged_in_client.post("/_admin_helpers/aplanar_imagenes/1", json=payload)
    resp_data = json.loads(resp.data)
    assert resp.status_code == 200 and resp_data["ok"] == True
    with app_instance.app_context():
        expected_url = url_for('main.lente_modelo', lente_id=1)
        expected_path = urlparse(expected_url).path # Extraer path
        assert resp_data["redirect"] == expected_path # Comparar paths
        model = db.session.get(Model, 1)
        assert model.path_to_img_front_flattened is not None
        p_front = Path(model.path_to_img_front_flattened); assert p_front.parts[-4:-1] == ('imgs', 'flattened', 'front')

def test_helper_imgs_to_svg_post(logged_in_client, app_instance):
    mock_svg_data = b'<svg></svg>'
    data = {'svg_frame': (io.BytesIO(mock_svg_data), 'frame.svg'), 'svg_glasses': (io.BytesIO(mock_svg_data), 'glasses.svg')}
    resp = logged_in_client.post("/_admin_helpers/imgs_to_svg/1", data=data, content_type='multipart/form-data')
    resp_data = json.loads(resp.data)
    assert resp.status_code == 200 and resp_data["ok"] == True
    with app_instance.app_context():
        expected_url = url_for('main.lente_modelo', lente_id=1)
        expected_path = urlparse(expected_url).path # Extraer path
        assert resp_data["redirect"] == expected_path # Comparar paths
        model = db.session.get(Model, 1)
        assert model.path_to_svg_frame is not None
        p_frame = Path(model.path_to_svg_frame); assert p_frame.parts[-3:-1] == ('svgs', 'frame')