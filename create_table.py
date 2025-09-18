"""
create_table.py
Crea SOLO la tabla de un modelo SQLAlchemy puntual (si no existe) leyendo config desde .env

Variables esperadas en .env:
  SQLALCHEMY_DATABASE_URI="mysql+pymysql://user:pass@host/dbname"
  MODEL_PATH="paquete.modulo:Clase"   # p.ej. "mi_app.models:Lente"
  ECHO_SQL="0"                        # opcional: "1" para mostrar SQL

Uso (opcionalmente se puede overridear por CLI):
  python create_one_table_env.py --env .env --model mi_app.models:Lente
  python create_one_table_env.py --env .env --db "sqlite:///mi_base.db"


"""

import argparse
import importlib
import os
import sys
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from dotenv import load_dotenv


def import_model(model_path: str):
    """
    model_path con formato 'paquete.modulo:Clase'
    """
    if ":" not in model_path:
        raise ValueError("MODEL_PATH debe ser 'paquete.modulo:Clase'")
    module_name, class_name = model_path.split(":", 1)
    mod = importlib.import_module(module_name)
    model_cls = getattr(mod, class_name, None)
    if model_cls is None:
        raise ImportError(f"No se encontró la clase '{class_name}' en '{module_name}'")
    if not hasattr(model_cls, "__table__"):
        raise TypeError("La clase importada no parece ser un modelo declarativo de SQLAlchemy (falta __table__)")
    return model_cls


def main():
    ap = argparse.ArgumentParser(description="Crear SOLO la tabla de un modelo específico si no existe (lee .env).")
    ap.add_argument("--env", default=".env", help="Ruta al archivo .env (default: ./.env)")
    ap.add_argument("--model", help="Override del MODEL_PATH ('paquete.modulo:Clase')")
    ap.add_argument("--db", help="Override de SQLALCHEMY_DATABASE_URI")
    args = ap.parse_args()

    # Cargar .env
    if os.path.isfile(args.env):
        load_dotenv(args.env)
    else:
        print(f"⚠ Aviso: no se encontró {args.env}; intentando leer del entorno…")

    # Leer config (permite override por CLI)
    db_uri = args.db or os.getenv("SQLALCHEMY_DATABASE_URI")
    model_path = args.model or os.getenv("MODEL_PATH")
    echo_sql = (os.getenv("ECHO_SQL") or "0").strip() in ("1", "true", "True")

    if not db_uri:
        print("✖ Falta SQLALCHEMY_DATABASE_URI (en .env o --db).", file=sys.stderr)
        sys.exit(1)
    if not model_path:
        print("✖ Falta MODEL_PATH (en .env o --model).", file=sys.stderr)
        sys.exit(1)

    try:
        engine = create_engine(db_uri, echo=echo_sql, future=True)

        # Validar conexión
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))

        print("✔ Conexión OK")
        print(f"→ Modelo objetivo: {model_path}")

        model_cls = import_model(model_path)
        table = model_cls.__table__

        # Crear solo esta tabla (si no existe). No toca ninguna otra.
        print(f"Creando tabla '{table.name}' si no existe…")
        table.create(bind=engine, checkfirst=True)
        print(f"✔ Listo: tabla '{table.name}' creada o ya existente.")

    except (SQLAlchemyError, ImportError, ValueError, TypeError) as e:
        print(f"✖ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
