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
        
        p4runtime_path = f"{args.file}info.txt"
        output = os.path.dirname(args.file)
        
        compile_command = f"p4c {args.file} --target bmv2 --arch v1model --p4runtime-files {p4runtime_path} -o {output}"

        result = subprocess.run(compile_command.split(" "), capture_output=True, text=True)

        # TODO delete .p4i file for failure

        if result.returncode == 0:
            return make_response(jsonify({'command': str(result.args), "stdout": str(result.stdout)}), 200)            
        else:
            return make_response(jsonify({'command': str(result.args), "stdout": str(result.stdout), "stderr": str(result.stderr)}), 500)            