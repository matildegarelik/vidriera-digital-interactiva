from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from .config import Config
from flask_socketio import SocketIO

db = SQLAlchemy()
socketio = SocketIO(cors_allowed_origins="*")  # permite conectar desde varias pestañas


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)
    socketio.init_app(app)

    from .routes import main
    app.register_blueprint(main)

    return app