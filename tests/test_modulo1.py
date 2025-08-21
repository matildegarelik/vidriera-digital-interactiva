import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


import pytest
from app import create_app, db
from app.models import Producto, ProductDescription, Categoria
@pytest.fixture
def client():
    # Configuración de la app en modo testing
    app = create_app({
        "TESTING": True,
        "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:"
    })

    with app.app_context():
        db.create_all()

        # Insertamos datos de prueba
        cat = Categoria(category_id=107, parent_id=None, top=True)
        db.session.add(cat)
        prod = Producto(product_id=1, model="Lente A", image="img.png", sku="SKU1", quantity=5, price=100, status=True)
        desc = ProductDescription(product_id=1, name="Lente de prueba")
        prod.categorias.append(cat)
        db.session.add_all([prod, desc])
        db.session.commit()

    return app.test_client()

def test_catalogo_status(client):
    # Chequear que la página responda
    resp = client.get("/catalogo")
    assert resp.status_code == 200
    assert b"Lente A" in resp.data  # el producto de prueba aparece en el HTML


