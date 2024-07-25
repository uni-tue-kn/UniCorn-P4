from api import create_app
from api.database import db

if __name__ == "__main__":
    print("App launch")
    app = create_app()
    with app.app_context():
        db.create_all()
    app.run(debug=True, host="0.0.0.0")
