from api import create_app

if __name__ == "__main__":
    print("App launch")
    app = create_app()
    app.run(debug=True, host="0.0.0.0", port=5001)