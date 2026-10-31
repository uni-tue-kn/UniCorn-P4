from concurrent.futures import ThreadPoolExecutor
from queue import Queue
import threading

import grpc
import pytest

from controller.p4.v1 import p4runtime_pb2 as pb, p4runtime_pb2_grpc
from controller.utils import switch as switch_module
from controller.utils.switch import SwitchConnection, IterableQueue


def connection():
    result = SwitchConnection.__new__(SwitchConnection)
    result.device_id, result.name = 0, 'test'
    result.requests_stream = IterableQueue(maxsize=256)
    result._init_stream_state()
    result._stream_primary = True
    return result


def test_complete_digest_is_captured_before_ack_and_filtered_pagination_is_lossless():
    result = connection()
    original_send = result._send_stream
    captured = []
    def send(request):
        # This executes at ACK enqueue time and proves capture preceded it.
        snapshot = result.GetDigestEvents()
        captured.append(pb.DigestList.FromString(snapshot['events'][-1]['payload']))
        original_send(request)
    result._send_stream = send
    for id_, list_id in ((1, 18446744073709551615), (2, 7), (1, 8)):
        digest = pb.DigestList(digest_id=id_, list_id=list_id)
        digest.data.add(bitstring=b'\xff' * 8)
        result._capture_digest(digest)
    assert [value.list_id for value in captured] == [18446744073709551615, 7, 8]
    ack = result.requests_stream.get_nowait()
    assert ack.WhichOneof('update') == 'digest_ack'
    assert ack.digest_ack.list_id == 18446744073709551615
    first = result.GetDigestEvents(digest_id=1, after=0, limit=1)
    assert first['next_sequence'] == '1'
    second = result.GetDigestEvents(digest_id=1, after=1, limit=1)
    assert [event['sequence'] for event in second['events']] == ['3']
    assert second['next_sequence'] == '3'
    result.ClearDigestEvents(1)
    assert [event['digest_id'] for event in result.GetDigestEvents()['events']] == [2]
    assert result._digest_event_bytes == sum(len(event['payload']) for event in result._digest_events)


def test_capture_overflow_evicts_oldest_and_reports_drops_without_unbounded_memory(monkeypatch):
    result = connection()
    monkeypatch.setattr(switch_module, 'DIGEST_MAX_EVENTS', 2)
    monkeypatch.setattr(switch_module, 'DIGEST_MAX_BYTES', 18)
    for list_id in range(1, 10):
        result._capture_digest(pb.DigestList(digest_id=1, list_id=list_id))
    snapshot = result.GetDigestEvents()
    assert len(snapshot['events']) == 2
    assert [event['sequence'] for event in snapshot['events']] == ['8', '9']
    assert snapshot['dropped'] == 7
    assert result._digest_event_bytes <= 18


def test_oversized_digest_or_backup_status_never_acks_incomplete_capture(monkeypatch):
    result = connection()
    monkeypatch.setattr(switch_module, 'DIGEST_MAX_LIST_ITEMS', 1)
    digest = pb.DigestList(digest_id=1, list_id=1)
    digest.data.add(bitstring=b'1')
    digest.data.add(bitstring=b'2')
    result._capture_digest(digest)
    monkeypatch.setattr(switch_module, 'DIGEST_MAX_LIST_BYTES', 1)
    result._capture_digest(pb.DigestList(digest_id=1, list_id=2))
    result._stream_primary = False
    result._capture_digest(pb.DigestList(digest_id=1, list_id=3))
    assert result.requests_stream.empty()
    assert result.GetDigestEvents()['events'] == []
    assert result.GetDigestEvents()['dropped'] == 3


def test_capture_byte_budget_evicts_even_below_event_count_limit(monkeypatch):
    result = connection()
    digest = pb.DigestList(digest_id=1, list_id=1)
    digest.data.add(bitstring=b'x' * 64)
    monkeypatch.setattr(switch_module, 'DIGEST_MAX_BYTES', digest.ByteSize() * 2)
    for list_id in range(1, 5):
        digest.list_id = list_id
        result._capture_digest(digest)
    snapshot = result.GetDigestEvents()
    assert [pb.DigestList.FromString(event['payload']).list_id for event in snapshot['events']] == [3, 4]
    assert snapshot['dropped'] == 2
    assert result._digest_event_bytes == digest.ByteSize() * 2


def test_shutdown_clears_capture_and_further_arrivals_never_ack():
    result = connection()
    result._capture_digest(pb.DigestList(digest_id=1, list_id=1))
    result.stream_msg_resp = type('Stream', (), {'cancel': lambda self: None})()
    result.channel = type('Channel', (), {'close': lambda self: None})()
    result.shutdown()
    result._capture_digest(pb.DigestList(digest_id=1, list_id=2))
    assert result.GetDigestEvents()['events'] == []
    assert result._digest_event_bytes == 0
    assert [request.digest_ack.list_id for request in result.requests_stream] == [1]


def test_full_ack_queue_preserves_capture_and_exposes_failure():
    result = connection()
    result.requests_stream = IterableQueue(maxsize=1)
    result.requests_stream.put_nowait(pb.StreamMessageRequest())
    result._capture_digest(pb.DigestList(digest_id=1, list_id=2))
    snapshot = result.GetDigestEvents()
    assert len(snapshot['events']) == 1
    assert 'not acknowledged' in snapshot['stream']['error']
    result.requests_stream.close()
    result.requests_stream.close()
    assert list(result.requests_stream) == []


def test_shutdown_all_closes_every_connection_even_when_shutdown_removes_it(monkeypatch):
    closed = []
    class Connection:
        def shutdown(self):
            closed.append(self)
            switch_module.connections.remove(self)
    active = [Connection(), Connection(), Connection()]
    monkeypatch.setattr(switch_module, 'connections', list(active))
    switch_module.ShutdownAllSwitchConnections()
    assert closed == active
    assert switch_module.connections == []


class Runtime(p4runtime_pb2_grpc.P4RuntimeServicer):
    def __init__(self):
        self.responses, self.acks = Queue(), Queue()
        self.calls = 0

    def StreamChannel(self, requests, context):
        self.calls += 1
        def read():
            try:
                for request in requests:
                    if request.HasField('arbitration'):
                        response = pb.StreamMessageResponse()
                        response.arbitration.CopyFrom(request.arbitration)
                        self.responses.put(response)
                    elif request.HasField('digest_ack'):
                        self.acks.put(request.digest_ack)
            except grpc.RpcError:
                pass  # Cancellation closes the server-side request iterator.
            finally:
                self.responses.put(None)
        threading.Thread(target=read, daemon=True).start()
        context.add_callback(lambda: self.responses.put(None))
        while context.is_active():
            response = self.responses.get(timeout=5)
            if response is None:
                return
            yield response


@pytest.fixture
def runtime():
    service = Runtime()
    server = grpc.server(ThreadPoolExecutor(max_workers=2))
    p4runtime_pb2_grpc.add_P4RuntimeServicer_to_server(service, server)
    port = server.add_insecure_port('127.0.0.1:0')
    server.start()
    client = SwitchConnection(name='test', address=f'127.0.0.1:{port}', device_id=7)
    try:
        yield service, client
    finally:
        client.shutdown()
        server.stop(0).wait(timeout=2)


def test_real_grpc_single_consumer_keeps_stream_alive_after_arbitration_and_acks(runtime):
    service, client = runtime
    assert client.MasterArbitrationUpdate().arbitration.device_id == 7
    response = pb.StreamMessageResponse()
    response.digest.CopyFrom(pb.DigestList(digest_id=0x17000001, list_id=9007199254740993))
    response.digest.data.add(bitstring=b'\x01\x02')
    service.responses.put(response)
    ack = service.acks.get(timeout=3)
    assert ack.digest_id == 0x17000001
    assert ack.list_id == 9007199254740993
    snapshot = client.GetDigestEvents()
    assert snapshot['stream'] == {'primary': True, 'active': True, 'error': None}
    assert len(snapshot['events']) == 1
    assert pb.DigestList.FromString(snapshot['events'][0]['payload']) == response.digest
    assert service.calls == 1
    client.shutdown()
    client.shutdown()
    assert not client._stream_thread.is_alive()
    assert client.GetDigestEvents()['events'] == []


def test_arbitration_loss_prevents_acks_and_stream_errors_are_visible(runtime):
    service, client = runtime
    client.MasterArbitrationUpdate()
    backup = pb.StreamMessageResponse()
    backup.arbitration.device_id = 7
    backup.arbitration.status.code = 7
    backup.arbitration.status.message = 'Another controller is primary'
    service.responses.put(backup)
    # FIFO guarantees the digest is processed after loss of primary status.
    digest = pb.StreamMessageResponse()
    digest.digest.CopyFrom(pb.DigestList(digest_id=1, list_id=5))
    service.responses.put(digest)
    # An arbitration update is an explicit synchronization point with reader.
    update = client._arbitration_updates.get(timeout=3)
    assert update.arbitration.status.code == 7
    client.shutdown()
    assert not client.GetDigestEvents()['stream']['primary']
    assert service.acks.empty()


def test_stream_end_wakes_arbitration_promptly(runtime):
    service, client = runtime
    service.responses.put(None)
    client._stream_thread.join(timeout=2)
    with pytest.raises(RuntimeError, match='stream closed'):
        client.MasterArbitrationUpdate()
