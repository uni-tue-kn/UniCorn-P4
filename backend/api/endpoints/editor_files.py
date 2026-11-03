"""Editor workspace routes; every file remains under the configured P4 root."""
from flask import request
from werkzeug.exceptions import RequestEntityTooLarge

from ..workspace import MAX_FILE_BYTES, WorkspaceError, list_workspace, read_workspace_file, save_workspace_file
from .Endpoint import Endpoint


class Workspace(Endpoint):
    def get(self):
        try:
            return list_workspace(), 200
        except WorkspaceError as error:
            return {'error': str(error)}, error.status


class WorkspaceFile(Endpoint):
    def get(self):
        try:
            return read_workspace_file(request.args.get('path')), 200
        except WorkspaceError as error:
            return {'error': str(error)}, error.status

    def _save(self, create):
        try:
            # JSON escaping can use six wire bytes per UTF-8 content byte.
            request.max_content_length = MAX_FILE_BYTES * 6 + 8192
            body = request.get_json(silent=True)
            if not isinstance(body, dict):
                return {'error': 'A JSON file document is required'}, 400
            result = save_workspace_file(body.get('path'), body.get('content'), body.get('revision'), create=create)
            return result, 201 if create else 200
        except WorkspaceError as error:
            return {'error': str(error), **({'conflict': True} if error.status == 409 else {})}, error.status
        except RequestEntityTooLarge:
            return {'error': 'The file request exceeds the editor size limit'}, 413

    def post(self):
        return self._save(create=True)

    def patch(self):
        return self._save(create=False)
