# vidriera-digital-interactiva
PFC
1. virtualenv venv
2. pip install -r requirements.txt
3. python main.py


correr tests: python -m pytest -v
(no se por qué el de socket solo anda si lo ejecuto así: pytest tests/test_modulo2.py::test_socketio_catalogo_control)

## aclaraciones
- está hardcodeado en el catalogo y el home del admin trar solo de 4 categorias solo 10 modelos de cada una
- falta el hasheo de la contraseña