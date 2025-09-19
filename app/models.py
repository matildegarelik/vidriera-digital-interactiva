from . import db
from sqlalchemy.dialects.mysql import JSON

# Tabla intermedia (producto ↔ categoría)
oc_product_to_category = db.Table(
    "oc_product_to_category",
    db.Column("product_id", db.Integer, db.ForeignKey("oc_product.product_id"), primary_key=True),
    db.Column("category_id", db.Integer, db.ForeignKey("oc_category.category_id"), primary_key=True)
)

class Categoria(db.Model):
    __tablename__ = "oc_category"

    category_id = db.Column(db.Integer, primary_key=True)
    parent_id = db.Column(db.Integer)   # por si hay subcategorías
    top = db.Column(db.Boolean)
    column = db.Column(db.Integer)
    sort_order = db.Column(db.Integer)
    status = db.Column(db.Boolean)
    date_added = db.Column(db.DateTime)
    date_modified = db.Column(db.DateTime)

    # relación con productos
    productos = db.relationship(
        "Producto",
        secondary=oc_product_to_category,
        back_populates="categorias"
    )

    def __repr__(self):
        return f"<Categoria {self.category_id}>"

class ProductDescription(db.Model):
    __tablename__ = "oc_product_description"

    product_id = db.Column(db.Integer, db.ForeignKey("oc_product.product_id"), primary_key=True)
    name = db.Column(db.String(255))

class Producto(db.Model):
    __tablename__ = "oc_product"

    product_id = db.Column(db.Integer, primary_key=True)
    model = db.Column(db.String(64))
    image = db.Column(db.String(150))
    sku = db.Column(db.String(64))
    upc = db.Column(db.String(12))
    quantity = db.Column(db.Integer)
    price = db.Column(db.Numeric(15, 4))
    status = db.Column(db.Boolean)
    date_added = db.Column(db.DateTime)
    date_modified = db.Column(db.DateTime)

    # relación con categorías
    categorias = db.relationship(
        "Categoria",
        secondary=oc_product_to_category,
        back_populates="productos"
    )

    descripcion = db.relationship(
        "ProductDescription",
        uselist=False,           # porque es 1:1
        backref="producto"
    )

    def __repr__(self):
        return f"<Producto {self.model} (${self.price})>"

class Usuario(db.Model):
    __tablename__ = "oc_user"

    user_id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64))
    password = db.Column(db.String(150))


class Model(db.Model):
    __tablename__ = 'ar_models'

    model_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    product_id = db.Column(
        db.Integer,
        db.ForeignKey("oc_product.product_id"),
        nullable=False
    )

    # Campos de datos
    name = db.Column(db.String(255), nullable=True)
    description = db.Column(db.String(255), nullable=True)
    visible = db.Column(db.Boolean, default=True, nullable=False)

    path_to_img_front = db.Column(db.String(255), nullable=True)
    path_to_img_side = db.Column(db.String(255), nullable=True)
    path_to_img_bg = db.Column(db.String(255), nullable=True)

    path_to_img_front_flattened = db.Column(db.String(255), nullable=True)
    path_to_img_side_flattened = db.Column(db.String(255), nullable=True)
    path_to_img_temple_flattened = db.Column(db.String(255), nullable=True)
    path_to_img_bg_flattened = db.Column(db.String(255), nullable=True)

    path_to_svg_frame = db.Column(db.String(255), nullable=True)
    path_to_svg_glasses = db.Column(db.String(255), nullable=True)
    path_to_svg_temple = db.Column(db.String(255), nullable=True)

    polarization_info = db.Column(JSON, nullable=True)

    path_to_glb = db.Column(db.String(255), nullable=True)

    config_for_display = db.Column(JSON, nullable=True)
