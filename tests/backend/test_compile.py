from types import SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def source(tmp_path, monkeypatch):
    root = tmp_path / "P4 files with 'quotes'"
    root.mkdir()
    path = root / "O'Brien program.p4"
    path.write_text('// compiler fixture\n')
    monkeypatch.setenv('P4_DIR', str(root))
    return path


def test_compile_returns_actual_json_argument_list_with_apostrophes(client, source, monkeypatch):
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout='compiled', stderr='warning'))
    monkeypatch.setattr('api.endpoints.compile.subprocess.run', run)
    response = client.post('/compile', json={'file': str(source)})
    assert response.status_code == 200
    assert isinstance(response.json['command'], list)
    assert response.json['command'] == run.call_args.args[0]
    assert response.json['command'][1] == str(source)
    assert response.json['stdout'] == 'compiled'
    assert response.json['stderr'] == 'warning'
    assert run.call_args.kwargs == {'capture_output': True, 'text': True}


def test_compile_failure_preserves_stderr_and_cleans_only_preprocessed_file(client, source, monkeypatch):
    temporary = source.with_suffix('.p4i')
    temporary.write_text('preprocessed')
    monkeypatch.setattr('api.endpoints.compile.subprocess.run', Mock(return_value=SimpleNamespace(returncode=1, stdout='', stderr='Syntax error')))
    response = client.post('/compile', json={'file': str(source)})
    assert response.status_code == 500
    assert response.json['stderr'] == 'Syntax error'
    assert isinstance(response.json['command'], list)
    assert source.exists()
    assert not temporary.exists()


def test_compiler_unavailable_is_a_structured_service_error(client, source, monkeypatch):
    monkeypatch.setattr('api.endpoints.compile.subprocess.run', Mock(side_effect=FileNotFoundError('p4c unavailable')))
    response = client.post('/compile', json={'file': str(source)})
    assert response.status_code == 503
    assert 'Could not start the P4 compiler' in response.json['error']
    assert isinstance(response.json['command'], list)


def test_invalid_or_missing_source_does_not_start_compiler(client, source, monkeypatch):
    run = Mock()
    monkeypatch.setattr('api.endpoints.compile.subprocess.run', run)
    for path in ('/etc/passwd', str(source.parent), str(source.parent / 'missing.p4')):
        response = client.post('/compile', json={'file': path})
        assert response.status_code == 400
        assert 'command' not in response.json
    run.assert_not_called()
