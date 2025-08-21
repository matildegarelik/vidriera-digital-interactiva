import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from app import create_app, db, socketio
from app.models import Categoria, Producto, ProductDescription


@pytest.fixture
def app_instance():
    app = create_app({
        "TESTING": True,
        "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:"
    })
    with app.app_context():
        db.create_all()

        cat = Categoria(category_id=107, parent_id=None, top=True)
        prod = Producto(product_id=1, model="Lente Test", image="test.png", sku="SKU1",
                        quantity=10, price=100, status=True)
        desc = ProductDescription(product_id=1, name="Lente de prueba")
        prod.categorias.append(cat)

        db.session.add_all([cat, prod, desc])
        db.session.commit()
    return app

@pytest.fixture
def client(app_instance):
    return app_instance.test_client()

def test_control_status(client):
    """Chequear que la página de control carga bien"""
    resp = client.get("/control")
    assert resp.status_code == 200
    assert b"Control" in resp.data or b"Panel" in resp.data  # depende de template

def test_socketio_catalogo_control(app_instance):
    client1 = socketio.test_client(app_instance, flask_test_client=app_instance.test_client())
    client2 = socketio.test_client(app_instance, flask_test_client=app_instance.test_client())

    data = {"categoria": 107, "producto": 1}
    client1.emit("cambiar_producto", data)

    socketio.sleep(0.1)

    received = client2.get_received()
    print("EVENTOS RECIBIDOS CLIENTE2:", received)

    client1.disconnect()
    client2.disconnect()


    assert any(evt["name"] == "actualizar_catalogo" for evt in received)


