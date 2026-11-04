"""Target dispatch at the controller boundary; HTTP resources stay target neutral."""


def create_target(device_id, config):
    target = config.get("target", "bmv2")
    if target == "bmv2":
        from ..managers.SwitchManager import SwitchManager
        return SwitchManager(device_id, config)
    if target == "tofino":
        from .tofino import TofinoTarget
        return TofinoTarget(device_id, config)
    raise ValueError("Unknown switch target: " + str(target))
