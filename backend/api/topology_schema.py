"""Validate saved Mininet topology drafts without contacting the emulator."""
import math
import re


def _number(value, label, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(label + ' must be a finite number')
    if (value <= 0) if positive else (value < 0):
        raise ValueError(label + (' must be positive' if positive else ' must be nonnegative'))


def validate_topology(topology):
    if not isinstance(topology, dict):
        raise ValueError('Topology must be an object')
    hosts, switches, links = (topology.get(key) for key in ('hosts', 'switches', 'links'))
    if not isinstance(hosts, list) or not isinstance(switches, dict) or not isinstance(links, list):
        raise ValueError('Topology requires hosts (list), switches (object), and links (list)')
    names = hosts + list(switches)
    if any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*\d', name) for name in names):
        raise ValueError('Node names must start with a letter and end with a numeric ID')
    if len(set(names)) != len(names):
        raise ValueError('Host and switch names must be unique')
    for group, limit in ((hosts, 254), (list(switches), 255)):
        ids = [int(re.search(r'\d+$', name).group()) for name in group]
        if any(not 1 <= value <= limit for value in ids):
            raise ValueError('Host IDs must be 1..254 and switch IDs 1..255')
        if len(set(ids)) != len(ids):
            raise ValueError('Numeric IDs must be unique within hosts and within switches')
    if any(not isinstance(properties, dict) for properties in switches.values()):
        raise ValueError('Switch properties must be objects')
    for index, link in enumerate(links):
        if not isinstance(link, list) or not 2 <= len(link) <= 4:
            raise ValueError(f'Link {index + 1} must contain two nodes and optional latency/bandwidth')
        left, right = link[:2]
        if left not in names or right not in names:
            raise ValueError(f'Link {index + 1} references an unknown node')
        if left == right or (left in hosts and right in hosts):
            raise ValueError('Links must connect distinct nodes and include a switch')
        if len(link) > 2:
            latency = link[2]
            if isinstance(latency, str):
                match = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(us|ms|s)', latency)
                if not match:
                    raise ValueError('Latency must be nonnegative milliseconds or use us, ms, s units')
                latency = float(match.group(1))
            _number(latency, 'Latency')
        if len(link) > 3:
            _number(link[3], 'Bandwidth', positive=True)
    interfaces = topology.get('ext_intfs', [])
    if not isinstance(interfaces, list):
        raise ValueError('ext_intfs must be a list')
    seen = set()
    for item in interfaces:
        if not isinstance(item, list) or len(item) != 2:
            raise ValueError('External interfaces must be [switch, interface] pairs')
        switch, interface = item
        if switch not in switches or not isinstance(interface, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', interface) or interface == 'lo':
            raise ValueError('External interfaces require a known switch and a valid non-loopback interface')
        if interface in seen:
            raise ValueError('An external interface may only be attached once')
        seen.add(interface)
    layout = topology.get('layout', {})
    if not isinstance(layout, dict) or any(name not in names for name in layout):
        raise ValueError('Layout must map existing nodes to positions')
    for position in layout.values():
        if not isinstance(position, dict) or 'x' not in position or 'y' not in position:
            raise ValueError('Each layout position requires x and y')
        _number(position['x'], 'Layout x')
        _number(position['y'], 'Layout y')
    return topology


def validate_deployable_topology(topology):
    """Drafts may be incomplete; the emulator's host addressing is single-homed."""
    validate_topology(topology)
    for host in topology['hosts']:
        count = sum(host in link[:2] for link in topology['links'])
        if count != 1:
            raise ValueError(f'Host {host} must have exactly one switch link before deployment (found {count}).')
    return topology
