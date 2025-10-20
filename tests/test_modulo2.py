import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from flask import url_for
from app import create_app, db, socketio
# Importar TODOS los modelos necesarios
from app.models import Categoria, Producto, ProductDescription, Model, oc_product_to_category, Usuario
import decimal

@pytest.fixture
def app_instance():
    app = create_app({
        "TESTING": True,
        "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:",
        "WTF_CSRF_ENABLED": False,
        "SERVER_NAME": "localhost.test",
        "SECRET_KEY": "testing-secret-key"
    })
    with app.app_context():
        db.create_all()
        # --- Datos de prueba completos ---
        cat1 = Categoria(category_id=100, sort_order=0)
        prod1 = Producto(product_id=1, model="Lente A", price=decimal.Decimal("100.50"))
        desc1 = ProductDescription(product_id=1, name="Descripcion Lente A")
        prod1.categorias.append(cat1)
        model1 = Model(
            model_id=1, product_id=1, name="Modelo AR Lente A",
            visible=True, sort_order=0,
            path_to_img_front_flattened="uploads/imgs/flattened/front/flat_front_1.png",
            path_to_glb="uploads/models/lente-a_test.glb"
        )
        admin_user = Usuario(user_id=1, username="admin", password="password")
        db.session.add_all([cat1, prod1, desc1, model1, admin_user])
        db.session.commit()
    return app

@pytest.fixture
def client(app_instance):
    """Usa la app_instance completa."""
    return app_instance.test_client()

def test_control_status(client):
    """Verifica que /control cargue."""
    resp = client.get("/control")
    assert resp.status_code == 200
    html = resp.data.decode("utf-8")
    assert "contenedor_general" in html
    assert "boton_probar" in html

