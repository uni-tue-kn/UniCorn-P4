from ..database.TableStates import *
from .Endpoint import Endpoint
from flask import current_app, jsonify, make_response
from flask_restful import reqparse
import subprocess, os
from ..program_builds import BuildError, contained_file, program_architecture, source_target


# Returns possible p4info and bmv2 files in the folder for initializing
class Compile(Endpoint):
    def post(self):

        parser = reqparse.RequestParser()
        parser.add_argument('file', required = True, type=str)
        parser.add_argument('target', default='auto', type=str)
        parser.add_argument('architecture', default='tofino', type=str)
        args = parser.parse_args()

        p4_dir = os.path.realpath(os.environ.get('P4_DIR', '/p4/'))
        file_path = os.path.realpath(args.file)

        # Ensure the file is within the allowed P4 directory
        if not file_path.startswith(p4_dir + os.sep) and file_path != p4_dir:
            return make_response(jsonify({'error': 'File path is outside the allowed directory'}), 400)
        if not os.path.isfile(file_path):
            return make_response(jsonify({'error': 'Select an existing P4 source file'}), 400)

        try:
            source = contained_file(file_path)
            if source.suffix.lower() != '.p4':
                raise BuildError('Select a P4 source file')
            if source_target(source, args.target) == 'tofino':
                architecture = args.architecture
                if args.target == 'auto' and program_architecture(source) == 't2na':
                    architecture = 'tofino2'
                return current_app.extensions['program_builds'].start(source, architecture), 202
        except BuildError as error:
            return {'error': str(error)}, error.status

        p4runtime_path = f"{file_path}info.txt"
        output = os.path.dirname(file_path)

        command = ["p4c", file_path, "--target", "bmv2", "--arch", "v1model",
                   "--p4runtime-files", p4runtime_path, "-o", output]
        try:
            result = subprocess.run(command, capture_output=True, text=True)
        except OSError as error:
            return make_response(jsonify({'command': command, 'error': 'Could not start the P4 compiler: ' + str(error)}), 503)

        if result.returncode == 0:
            return make_response(jsonify({'command': command, "stdout": str(result.stdout), "stderr": str(result.stderr)}), 200)
        else:
            # Delete .p4i file for failure
            try:
                os.remove(f"{file_path}i")
            except Exception:
                pass
            return make_response(jsonify({'command': command, "stdout": str(result.stdout), "stderr": str(result.stderr)}), 500)
