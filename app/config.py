import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

class Config:
    SECRET_KEY = "clave"
    SQLALCHEMY_DATABASE_URI = f"mysql+pymysql://usuario_mutual:@localhost/mutual"
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    TESTING=False
