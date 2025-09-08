import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
from dotenv import load_dotenv
import os

load_dotenv()  # busca un archivo .env en la raíz

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "default-key")
    SQLALCHEMY_DATABASE_URI = os.getenv("SQLALCHEMY_DATABASE_URI", "sqlite:///default.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    TESTING=False
