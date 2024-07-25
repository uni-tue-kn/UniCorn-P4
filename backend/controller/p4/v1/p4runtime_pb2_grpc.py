# Generated by the gRPC Python protocol compiler plugin. DO NOT EDIT!
import grpc

from . import p4runtime_pb2 as p4_dot_v1_dot_p4runtime__pb2


class P4RuntimeStub(object):
  # missing associated documentation comment in .proto file
  pass

  def __init__(self, channel):
    """Constructor.

    Args:
      channel: A grpc.Channel.
    """
    self.Write = channel.unary_unary(
        '/p4.v1.P4Runtime/Write',
        request_serializer=p4_dot_v1_dot_p4runtime__pb2.WriteRequest.SerializeToString,
        response_deserializer=p4_dot_v1_dot_p4runtime__pb2.WriteResponse.FromString,
        )
    self.Read = channel.unary_stream(
        '/p4.v1.P4Runtime/Read',
        request_serializer=p4_dot_v1_dot_p4runtime__pb2.ReadRequest.SerializeToString,
        response_deserializer=p4_dot_v1_dot_p4runtime__pb2.ReadResponse.FromString,
        )
    self.SetForwardingPipelineConfig = channel.unary_unary(
        '/p4.v1.P4Runtime/SetForwardingPipelineConfig',
        request_serializer=p4_dot_v1_dot_p4runtime__pb2.SetForwardingPipelineConfigRequest.SerializeToString,
        response_deserializer=p4_dot_v1_dot_p4runtime__pb2.SetForwardingPipelineConfigResponse.FromString,
        )
    self.GetForwardingPipelineConfig = channel.unary_unary(
        '/p4.v1.P4Runtime/GetForwardingPipelineConfig',
        request_serializer=p4_dot_v1_dot_p4runtime__pb2.GetForwardingPipelineConfigRequest.SerializeToString,
        response_deserializer=p4_dot_v1_dot_p4runtime__pb2.GetForwardingPipelineConfigResponse.FromString,
        )
    self.StreamChannel = channel.stream_stream(
        '/p4.v1.P4Runtime/StreamChannel',
        request_serializer=p4_dot_v1_dot_p4runtime__pb2.StreamMessageRequest.SerializeToString,
        response_deserializer=p4_dot_v1_dot_p4runtime__pb2.StreamMessageResponse.FromString,
        )
    self.Capabilities = channel.unary_unary(
        '/p4.v1.P4Runtime/Capabilities',
        request_serializer=p4_dot_v1_dot_p4runtime__pb2.CapabilitiesRequest.SerializeToString,
        response_deserializer=p4_dot_v1_dot_p4runtime__pb2.CapabilitiesResponse.FromString,
        )


class P4RuntimeServicer(object):
  # missing associated documentation comment in .proto file
  pass

  def Write(self, request, context):
    """Update one or more P4 entities on the target.
    """
    context.set_code(grpc.StatusCode.UNIMPLEMENTED)
    context.set_details('Method not implemented!')
    raise NotImplementedError('Method not implemented!')

  def Read(self, request, context):
    """Read one or more P4 entities from the target.
    """
    context.set_code(grpc.StatusCode.UNIMPLEMENTED)
    context.set_details('Method not implemented!')
    raise NotImplementedError('Method not implemented!')

  def SetForwardingPipelineConfig(self, request, context):
    """Sets the P4 forwarding-pipeline config.
    """
    context.set_code(grpc.StatusCode.UNIMPLEMENTED)
    context.set_details('Method not implemented!')
    raise NotImplementedError('Method not implemented!')

  def GetForwardingPipelineConfig(self, request, context):
    """Gets the current P4 forwarding-pipeline config.
    """
    context.set_code(grpc.StatusCode.UNIMPLEMENTED)
    context.set_details('Method not implemented!')
    raise NotImplementedError('Method not implemented!')

  def StreamChannel(self, request_iterator, context):
    """Represents the bidirectional stream between the controller and the
    switch (initiated by the controller), and is managed for the following
    purposes:
    - connection initiation through client arbitration
    - indicating switch session liveness: the session is live when switch
    sends a positive client arbitration update to the controller, and is
    considered dead when either the stream breaks or the switch sends a
    negative update for client arbitration
    - the controller sending/receiving packets to/from the switch
    - streaming of notifications from the switch
    """
    context.set_code(grpc.StatusCode.UNIMPLEMENTED)
    context.set_details('Method not implemented!')
    raise NotImplementedError('Method not implemented!')

  def Capabilities(self, request, context):
    # missing associated documentation comment in .proto file
    pass
    context.set_code(grpc.StatusCode.UNIMPLEMENTED)
    context.set_details('Method not implemented!')
    raise NotImplementedError('Method not implemented!')


def add_P4RuntimeServicer_to_server(servicer, server):
  rpc_method_handlers = {
      'Write': grpc.unary_unary_rpc_method_handler(
          servicer.Write,
          request_deserializer=p4_dot_v1_dot_p4runtime__pb2.WriteRequest.FromString,
          response_serializer=p4_dot_v1_dot_p4runtime__pb2.WriteResponse.SerializeToString,
      ),
      'Read': grpc.unary_stream_rpc_method_handler(
          servicer.Read,
          request_deserializer=p4_dot_v1_dot_p4runtime__pb2.ReadRequest.FromString,
          response_serializer=p4_dot_v1_dot_p4runtime__pb2.ReadResponse.SerializeToString,
      ),
      'SetForwardingPipelineConfig': grpc.unary_unary_rpc_method_handler(
          servicer.SetForwardingPipelineConfig,
          request_deserializer=p4_dot_v1_dot_p4runtime__pb2.SetForwardingPipelineConfigRequest.FromString,
          response_serializer=p4_dot_v1_dot_p4runtime__pb2.SetForwardingPipelineConfigResponse.SerializeToString,
      ),
      'GetForwardingPipelineConfig': grpc.unary_unary_rpc_method_handler(
          servicer.GetForwardingPipelineConfig,
          request_deserializer=p4_dot_v1_dot_p4runtime__pb2.GetForwardingPipelineConfigRequest.FromString,
          response_serializer=p4_dot_v1_dot_p4runtime__pb2.GetForwardingPipelineConfigResponse.SerializeToString,
      ),
      'StreamChannel': grpc.stream_stream_rpc_method_handler(
          servicer.StreamChannel,
          request_deserializer=p4_dot_v1_dot_p4runtime__pb2.StreamMessageRequest.FromString,
          response_serializer=p4_dot_v1_dot_p4runtime__pb2.StreamMessageResponse.SerializeToString,
      ),
      'Capabilities': grpc.unary_unary_rpc_method_handler(
          servicer.Capabilities,
          request_deserializer=p4_dot_v1_dot_p4runtime__pb2.CapabilitiesRequest.FromString,
          response_serializer=p4_dot_v1_dot_p4runtime__pb2.CapabilitiesResponse.SerializeToString,
      ),
  }
  generic_handler = grpc.method_handlers_generic_handler(
      'p4.v1.P4Runtime', rpc_method_handlers)
  server.add_generic_rpc_handlers((generic_handler,))
