from .Endpoint import Endpoint
from flask import jsonify, make_response
from flask_restful import reqparse

# Returns possible p4info and bmv2 files in the folder for initializing
class LogFile(Endpoint):
    def get(self):

        parser = reqparse.RequestParser()
        parser.add_argument('file', required = True, type=str, location = 'values')
        parser.add_argument('limit', required=False, type=int, location = 'values')
        args = parser.parse_args()

        try:
            with open(self.netsim.log_dir + "/" + args.file, 'r') as file:
                data = file.read()
            if args.limit and args.limit > 0 and args.limit < 1000:
                # TODO: Upper limit in general
                lines = data.split("\n")
                lines = lines[len(lines) - args.limit - 1:-1]
                data = "\n".join(lines)
            
        except FileNotFoundError as e:
            return make_response(jsonify({'file': args.file, "error": str(e)}), 404)                        
        except Exception as e:
            return make_response(jsonify({'file': args.file, "error": str(e)}), 500)                        
        
        return make_response(jsonify({'file': str(args.file), "content": str(data)}), 200)
