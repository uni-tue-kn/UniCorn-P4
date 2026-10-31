"""Validate explicit adapter settings without opening a native connection."""


def normalize_adapter_config(config):
    if not isinstance(config, dict):
        raise ValueError("switch_config must contain a JSON object")
    result = dict(config)
    for field in ("name", "address"):
        if not isinstance(result.get(field), str) or not result[field].strip():
            raise ValueError(f"{field} must be a nonempty string")
    device_id = result.get("device_id")
    if isinstance(device_id, bool) or not isinstance(device_id, int) or device_id < 0:
        raise ValueError("device_id must be a nonnegative integer")
    result.setdefault("proto_dump_file", None)
    enabled = result.get("register_adapter_enabled", False)
    host = result.get("register_thrift_host")
    port = result.get("register_thrift_port")
    if not isinstance(enabled, bool):
        raise ValueError("register_adapter_enabled must be a boolean")
    if host is not None and not isinstance(host, str):
        raise ValueError("register_thrift_host must be a hostname")
    if isinstance(host, str):
        host = host.strip() or None
    if port is not None and (isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535):
        raise ValueError("register_thrift_port must be an integer between 1 and 65535")
    if enabled and (host is None or port is None):
        raise ValueError("Enabling the register adapter requires an explicit Thrift host and port")
    result.update(register_adapter_enabled=enabled, register_thrift_host=host, register_thrift_port=port)
    return result
