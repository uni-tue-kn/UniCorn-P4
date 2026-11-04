"""Validate target connection settings without opening a native connection."""


def normalize_adapter_config(config):
    if not isinstance(config, dict):
        raise ValueError("switch_config must contain a JSON object")
    allowed = {"name", "address", "device_id", "proto_dump_file", "target", "target_options",
               "register_adapter_enabled", "register_thrift_host", "register_thrift_port"}
    if set(config) - allowed:
        raise ValueError("Unknown switch settings: " + ", ".join(sorted(set(config) - allowed)))
    result = dict(config)
    for field in ("name", "address"):
        if not isinstance(result.get(field), str) or not result[field].strip():
            raise ValueError(f"{field} must be a nonempty string")
    device_id = result.get("device_id")
    if isinstance(device_id, bool) or not isinstance(device_id, int) or device_id < 0:
        raise ValueError("device_id must be a nonnegative integer")
    result.setdefault("proto_dump_file", None)
    if result["proto_dump_file"] is not None and not isinstance(result["proto_dump_file"], str):
        raise ValueError("proto_dump_file must be a string or null")
    target = result.get("target", "bmv2")
    if target not in ("bmv2", "tofino"):
        raise ValueError("target must be bmv2 or tofino")
    options = result.get("target_options")
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise ValueError("target_options must contain a JSON object")
    allowed = {"program_name", "client_id", "pipe_id", "runtime_device_id", "read_only"}
    if set(options) - allowed:
        raise ValueError("Unknown target_options: " + ", ".join(sorted(set(options) - allowed)))
    if target == "bmv2" and options:
        raise ValueError("target_options are only supported for tofino")
    options = dict(options)
    if "read_only" in options and not isinstance(options["read_only"], bool):
        raise ValueError("read_only must be a boolean")
    if "program_name" in options and (not isinstance(options["program_name"], str) or not options["program_name"].strip()):
        raise ValueError("program_name must be a nonempty string")
    for key, default, maximum in (("client_id", 0, (1 << 32) - 1), ("runtime_device_id", 0, (1 << 32) - 1), ("pipe_id", 0, 65534)):
        if target == "tofino":
            value = options.get(key, default)
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"{key} is outside the supported range")
            options[key] = value
    result.update(target=target, target_options=options)
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
    if target == "tofino" and (enabled or host is not None or port is not None):
        raise ValueError("BMv2 Thrift settings cannot be used with a tofino target")
    result.update(register_adapter_enabled=enabled, register_thrift_host=host, register_thrift_port=port)
    return result
