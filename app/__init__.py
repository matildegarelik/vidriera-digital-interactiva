from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from .config import Config
from flask_socketio import SocketIO
from dotenv import load_dotenv
import os

# Cargar .env relativo al proyecto, funciona sin importar donde este deployado
_HERE = os.path.dirname(os.path.abspath(__file__))          # vidriera/app/
_PROJECT_ROOT = os.path.dirname(_HERE)                       # vidriera/
ENV_PATH = os.path.join(_PROJECT_ROOT, '.env')
load_dotenv(ENV_PATH)


db=SQLAlchemy()
socketio = SocketIO(cors_allowed_origins="*",async_mode="threading")  # permite conectar desde varias pestañas


def create_app(test_config=None):
    app=Flask(__name__)
    app.config.from_object(Config)

    if test_config:
        app.config.update(test_config)

    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db.init_app(app)
    socketio.init_app(app)

    from .routes import main
    app.register_blueprint(main)

    return app
