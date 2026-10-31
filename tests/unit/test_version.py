from io import BytesIO
import socket

import pytest

from unicorn_version import check_update, local_version, parse_version, register_version_routes


@pytest.mark.parametrize("older,newer", [
    ("1.1.0", "1.2.0"), ("1.2.0-dev.0", "1.2.0"),
    ("1.2.0-rc.2", "1.2.0-rc.10"), ("1.2.0-2", "1.2.0-alpha"),
    ("1.2.0-alpha", "1.2.0-alpha.1"),
])
def test_semantic_version_order(older, newer):
    assert parse_version(older) < parse_version(newer)


@pytest.mark.parametrize("value", ["1.2", "1.2.0-01", "01.2.0", "1.2.0\nhtml", "<html>"])
def test_malformed_versions(value):
    with pytest.raises(ValueError):
        parse_version(value)


@pytest.mark.parametrize("remote,available", [(b"1.3.0\n", True), (b"1.2.0", False), (b"1.1.0", False)])
def test_check_result(remote, available):
    result = check_update("1.2.0", lambda request, timeout: BytesIO(remote))
    assert result["status"] == "checked"
    assert result["update_available"] is available


@pytest.mark.parametrize("remote", [b"404: Not Found", b"x" * 129, b"\xff"])
def test_bad_remote_is_advisory(remote):
    result = check_update("1.2.0", lambda request, timeout: BytesIO(remote))
    assert result["status"] == "unavailable"
    assert not result["update_available"]


def test_network_timeout_is_advisory():
    def timeout(request, timeout):
        raise socket.timeout()
    assert check_update("1.2.0", timeout)["status"] == "unavailable"


def test_baked_version_and_disabled_check(tmp_path, monkeypatch):
    from flask import Flask
    version_file = tmp_path / "VERSION"
    version_file.write_text("1.2.0-dev.0\n")
    monkeypatch.setenv("VERSION_FILE", str(version_file))
    monkeypatch.setenv("UPDATE_CHECK_ENABLED", "false")
    assert local_version() == "1.2.0-dev.0"
    app = Flask(__name__)
    register_version_routes(app, "backend")
    result = app.test_client().get("/version").get_json()
    assert result["component"] == "backend"
    assert result["version"] == "1.2.0-dev.0"
    assert result["update"]["status"] == "disabled"
    assert app.test_client().get("/health").status_code == 200
