from flask import request, send_file
from werkzeug.exceptions import RequestEntityTooLarge

from .Endpoint import Endpoint
from ..network_archive import MAX_ARCHIVE, build_archive, stage_import, deploy_import


class NetworkExport(Endpoint):
    def get(self):
        try:
            archive = build_archive(self.controller, request.args.get('topology_file'))
            return send_file(archive, mimetype='application/zip', as_attachment=True,
                             download_name='UniCorn-P4-network.zip', max_age=0)
        except (ValueError, TypeError, OSError) as error:
            return {'error': str(error)}, 400


class NetworkImport(Endpoint):
    def post(self):
        # Bound multipart parsing itself, before Werkzeug can spool an oversized
        # upload to disk. The extra MiB permits multipart headers/form overhead.
        request.max_content_length = MAX_ARCHIVE + 1024 * 1024
        try:
            upload = request.files.get('file')
            if upload is None:
                return {'error': 'Upload a network ZIP archive using multipart field file'}, 400
            raw = upload.stream.read(MAX_ARCHIVE + 1)
            return stage_import(raw), 200
        except RequestEntityTooLarge:
            return {'error': 'Network archive upload exceeds the 65 MiB request limit'}, 413
        except (ValueError, TypeError, OSError, UnicodeError, RecursionError) as error:
            return {'error': str(error)}, 400


class NetworkDeploy(Endpoint):
    def post(self):
        try:
            return deploy_import(self.controller, self.db, request.get_json(silent=True)), 200
        except (ValueError, TypeError) as error:
            return {'error': str(error)}, 400
        except KeyError as error:
            return {'error': str(error)}, 404
        except RuntimeError as error:
            return {'error': str(error)}, 409
