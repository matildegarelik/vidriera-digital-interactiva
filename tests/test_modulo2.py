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
    resp = client.get("/control")
    assert resp.status_code == 200
    html = resp.data.decode("utf-8")
    assert "contenedor_general" in html  # clase principal del template
    assert "boton_probar" in html        # botón de prueba


def test_socketio_catalogo_control(app_instance):
    # app_instance es la Flask app
    app = app_instance

    # Dos clientes: control (emite) y catálogo (recibe)
    flask_client_ctrl = app.test_client()
    flask_client_cat  = app.test_client()

    client_ctrl = socketio.test_client(app, flask_test_client=flask_client_ctrl, namespace="/")
    client_cat  = socketio.test_client(app, flask_test_client=flask_client_cat,  namespace="/")

    assert client_ctrl.is_connected(namespace="/")
    assert client_cat.is_connected(namespace="/")

    # Limpiar colas por si quedó algo de otros tests
    client_ctrl.get_received(namespace="/")
    client_cat.get_received(namespace="/")

    # El control pide mover producto → catálogo debe recibir actualizar_producto
    payload = {"direccion": "derecha"}
    client_ctrl.emit("mover_producto", payload, namespace="/")

    socketio.sleep(0.15)

    received = client_cat.get_received(namespace="/")
    print("EVENTOS RECIBIDOS CLIENTE2:", received)

    client_ctrl.disconnect(namespace="/")
    client_cat.disconnect(namespace="/")

    assert any(evt.get("name") == "actualizar_producto" for evt in received), \
        f"No llegó 'actualizar_producto'. Recibido: {received}"



