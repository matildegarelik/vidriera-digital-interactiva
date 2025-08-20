from app import create_app, db
from app.models import Producto

app = create_app()

with app.app_context():
    db.create_all()  # crea las tablas si no existen

if __name__ == '__main__':
    app.run(debug=True)