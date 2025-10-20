import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from app import create_app, db
from app.models import Categoria, Producto, ProductDescription, Model

@pytest.fixture
def app_instance():
    """Configura la app en modo testing con una base de datos en memoria."""
    app = create_app({
        "TESTING": True,
        "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:",
        "SERVER_NAME": "localhost.test" 
    })
    with app.app_context():
        db.create_all()
        cat1 = Categoria(category_id=100)
        prod1 = Producto(product_id=1, model="Lente A", price=100)
        desc1 = ProductDescription(product_id=1, name="Descripcion Lente A")
        prod1.categorias.append(cat1)
        model1 = Model(
            model_id=1, product_id=1, name="Modelo AR Lente A",
            path_to_glb="uploads/models/lente-a_test.glb",
            config_for_display={"offsetX": 0.1, "offsetY": -0.2}
        )
        prod2 = Producto(product_id=2, model="Lente C", price=200)
        desc2 = ProductDescription(product_id=2, name="Descripcion Lente C")
        prod2.categorias.append(cat1)
        model2 = Model(
            model_id=2, product_id=2, name="Modelo AR Lente C", path_to_glb=None
        )
        db.session.add_all([cat1, prod1, prod2, desc1, desc2, model1, model2])
        db.session.commit()
    return app

@pytest.fixture
def client(app_instance):
    return app_instance.test_client()

# --- Tests de Prueba Virtual ---
def test_probar_lente_page_loads_with_glb(client):
    resp = client.get("/probar-lente/1")
    assert resp.status_code == 200 and b"Probar lente" in resp.data
    resp_data = resp.data.decode("utf-8")
    assert "models/lente-a_test.glb" in resp_data
    assert '"offsetX": 0.1' in resp_data and '"offsetY": -0.2' in resp_data

def test_probar_lente_404_if_no_glb(client):
    resp = client.get("/probar-lente/2")
    assert resp.status_code == 404 and b"El modelo no tiene GLB disponible" in resp.data

def test_probar_lente_404_if_no_model(client):
    resp = client.get("/probar-lente/999")
    assert resp.status_code == 404