from ..database.TableStates import *
from .Endpoint import Endpoint
from flask import jsonify, make_response
from flask_restful import reqparse
import subprocess, os


# Returns possible p4info and bmv2 files in the folder for initializing
class Compile(Endpoint):
    def post(self):

        parser = reqparse.RequestParser()
        parser.add_argument('file', required = True, type=str)
        args = parser.parse_args()

        p4_dir = os.path.realpath(os.environ.get('P4_DIR', '/p4/'))
        file_path = os.path.realpath(args.file)

        # Ensure the file is within the allowed P4 directory
        if not file_path.startswith(p4_dir + os.sep) and file_path != p4_dir:
            return make_response(jsonify({'error': 'File path is outside the allowed directory'}), 400)

        p4runtime_path = f"{file_path}info.txt"
        output = os.path.dirname(file_path)

        result = subprocess.run(
            ["p4c", file_path, "--target", "bmv2", "--arch", "v1model",
             "--p4runtime-files", p4runtime_path, "-o", output],
            capture_output=True, text=True)

        if result.returncode == 0:
            return make_response(jsonify({'command': str(result.args), "stdout": str(result.stdout)}), 200)
        else:
            # Delete .p4i file for failure
            try:
                os.remove(f"{file_path}i")
            except Exception:
                pass
            return make_response(jsonify({'command': str(result.args), "stdout": str(result.stdout), "stderr": str(result.stderr)}), 500)            