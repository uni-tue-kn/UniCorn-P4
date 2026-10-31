"""Explicit native BMv2 queue controls; no queue configuration getter exists."""
from datetime import datetime, timezone
from threading import RLock

from thrift.Thrift import TApplicationException, TException
from thrift.protocol import TBinaryProtocol, TMultiplexedProtocol
from thrift.transport import TSocket, TTransport

from .ResourceManager import integer


_CACHE_LOCK = RLock()
LIMITS = {'max_port': 510, 'max_depth_packets': (1 << 31) - 1,
          'max_rate_pps': str((1 << 63) - 1)}


class QueueEndpointRequired(ValueError):
    pass


class QueueApplyError(Exception):
    def __init__(self, message, applied, failed_setting=None, uncertain=False, unsupported=False):
        super().__init__(message)
        self.applied = applied
        self.failed_setting = failed_setting
        self.uncertain = uncertain
        self.unsupported = unsupported


class QueueManager:
    @classmethod
    def for_switch(cls, switch):
        # The cache belongs to this active connection, never to a database row.
        with _CACHE_LOCK:
            existing = getattr(switch, '_queue_manager', None)
            endpoint = (switch.config.get('register_thrift_host'), switch.config.get('register_thrift_port'))
            if existing is None or existing.connection is not switch.bmv2 or existing.endpoint != endpoint:
                existing = cls(switch.bmv2, endpoint)
                switch._queue_manager = existing
            return existing

    def __init__(self, connection, endpoint):
        self.connection = connection
        self.endpoint = endpoint
        self.lock = RLock()
        self.history = []
        self.defaults = {'depth_packets': None, 'rate_pps': None}
        self.overrides = {}
        self.known_ports = set()

    def configured(self):
        host, port = self.endpoint
        return (isinstance(host, str) and bool(host.strip()) and isinstance(port, int)
                and not isinstance(port, bool) and 1 <= port <= 65535)

    @staticmethod
    def selector(data):
        if data.get('priority') is not None:
            raise ValueError('Priority selection is unsupported; omit priority to configure all priorities')
        port = data.get('port')
        return None if port is None else integer(port, 'port', maximum=LIMITS['max_port'])

    def _discover_ports(self):
        if not self.configured():
            return {}, {'status': 'not_configured', 'error': None}
        transport = None
        try:
            transport, client = self._ports_client()
            ports = {integer(item.port_num, 'native port', maximum=LIMITS['max_port']):
                     {'interface': item.iface_name, 'is_up': item.is_up}
                     for item in client.bm_dev_mgr_show_ports()}
            return ports, {'status': 'available', 'error': None}
        except (TException, OSError, ValueError, TypeError, AttributeError) as error:
            return {}, {'status': 'unavailable', 'error': str(error) or 'Native port discovery failed'}
        finally:
            if transport is not None:
                transport.close()

    def snapshot(self, port=None, discover=True):
        discovered, discovery = self._discover_ports() if discover else ({}, {'status': 'not_requested', 'error': None})
        with self.lock:
            history = [dict(row) for row in self.history if port is None or row['port'] in (None, port)]
            configured = self.configured()
            numbers = set(discovered) | self.known_ports
            if port is not None:
                numbers = {port}
            ports = []
            for number in sorted(numbers):
                override = self.overrides.get(number, {})
                values = {field: override.get(field, value) for field, value in self.defaults.items()}
                ports.append({'port': number, 'interface': discovered.get(number, {}).get('interface'),
                              'is_up': discovered.get(number, {}).get('is_up'), 'discovered': number in discovered,
                              **values, 'sources': {field: 'port' if field in override else 'all_ports' if value is not None else 'unknown'
                                                   for field, value in values.items()}})
            return {'configured': configured, 'write_available': configured,
                    'readback_available': False, 'priority_selection_available': False,
                    'state': 'last_applied' if any(value is not None for value in self.defaults.values()) or any(self.overrides.values()) else 'unknown', 'last_applied': history,
                    'configuration': {'source': 'connection_cache', 'defaults': dict(self.defaults), 'ports': ports},
                    'port_discovery': discovery,
                    'limits': dict(LIMITS),
                    'message': ('Last configured here means acknowledged settings from this connection, not switch readback. '
                                'BMv2 exposes no queue configuration getters, so external changes are not detected. Unknown values are not inferred.'
                                if configured else 'Configure an explicit BMv2 Thrift host and port in this switch connection to edit queues.')}

    def _client(self):
        from runtime.thrift.sswitch_runtime import SimpleSwitch
        transport, protocol = self._connect('simple_switch')
        return transport, SimpleSwitch.Client(protocol)

    def _ports_client(self):
        from runtime.thrift.bm_runtime.standard import Standard
        transport, protocol = self._connect('standard')
        return transport, Standard.Client(protocol)

    def _connect(self, service):
        host, port = self.endpoint
        socket = TSocket.TSocket(host, port)
        socket.setTimeout(5000)
        transport = TTransport.TBufferedTransport(socket)
        protocol = TMultiplexedProtocol.TMultiplexedProtocol(
            TBinaryProtocol.TBinaryProtocol(transport), service)
        transport.open()
        return transport, protocol

    def write(self, data):
        port = self.selector(data)
        settings = []
        if 'depth_packets' in data:
            settings.append(('depth_packets', integer(data['depth_packets'], 'depth_packets', minimum=1,
                                                      maximum=LIMITS['max_depth_packets'])))
        if 'rate_pps' in data:
            settings.append(('rate_pps', integer(data['rate_pps'], 'rate_pps', maximum=int(LIMITS['max_rate_pps']))))
        if not settings:
            raise ValueError('Provide depth_packets or rate_pps')
        if not self.configured():
            raise QueueEndpointRequired('Queue controls require an explicit BMv2 Thrift host and port')
        applied = []
        failed_setting = None
        transport = None
        with self.lock:
            try:
                transport, client = self._client()
                for field, value in settings:
                    failed_setting = field
                    method = ('set_all_egress_queue_depths' if field == 'depth_packets' else 'set_all_egress_queue_rates') if port is None else (
                        'set_egress_queue_depth' if field == 'depth_packets' else 'set_egress_queue_rate')
                    arguments = (value,) if port is None else (port, value)
                    result = getattr(client, method)(*arguments)
                    if result != 0:
                        raise QueueApplyError(f'BMv2 rejected {field} with return code {result}', applied, field)
                    change = {'port': port, field: str(value) if field == 'rate_pps' else value,
                              'applied_at': datetime.now(timezone.utc).isoformat()}
                    if port is None:
                        self.defaults[field] = change[field]
                        for override in self.overrides.values():
                            override.pop(field, None)
                    else:
                        self.known_ports.add(port)
                        self.overrides.setdefault(port, {})[field] = change[field]
                    self.history.append(change)
                    self.history = self.history[-100:]
                    applied.append(dict(change))
            except QueueApplyError:
                raise
            except TApplicationException as error:
                unsupported = error.type == TApplicationException.UNKNOWN_METHOD
                raise QueueApplyError(str(error), applied, failed_setting,
                                      uncertain=not unsupported and failed_setting is not None,
                                      unsupported=unsupported) from error
            except (TException, OSError) as error:
                raise QueueApplyError('BMv2 Thrift queue operation failed: ' + str(error), applied,
                                      failed_setting, uncertain=failed_setting is not None) from error
            finally:
                if transport is not None:
                    transport.close()
        return applied
