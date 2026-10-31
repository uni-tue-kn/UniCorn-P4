from .TableManager import TableManager
from .TableEntry import TableEntry
from .ResourceManager import ResourceManager, register_type
from functools import wraps
import logging
from ..utils.bmv2 import Bmv2SwitchConnection
from ..utils.helper import P4InfoHelper
from grpc import RpcError
from google.protobuf.json_format import MessageToDict
from google.protobuf.struct_pb2 import Struct
import grpc

class SwitchManager:
    # TODO: refactor to pass dataclass here
    def __init__(self, id, config):
        self.id = id
        self.db_id = -1
        self.config = config
        self.bmv2 = None
        self.connected = False
        self.tables = None
        self.p4_helper = None
        self.p4_file = None
        self.bmv2_file = None
        self.state_id = None
        self.p4runtime_api_version = None
        self.resources = ResourceManager(self)
        self._register_adapter = None
        self.register_access = {"mode": "unknown", "source": "unknown", "status": "unknown",
                                "available": None, "read": None, "write": None, "max_bitwidth": None}
        self._register_probe_done = False


    def check_connected(func):
        """Wrapper for functions that require a BMv2 connection
        """
        # Note: args[0] is equal to self
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not args[0].connected:
                logging.error(
                    "Tried to call {} but it requires a switch connection. SwitchManager:{}".format(func,args[0].config))
                raise RuntimeError("Switch is not connected")
            return func(*args, **kwargs)
        return wrapper
    
    # TODO: when switch has already loaded program, this crashes everything
    # Add fix for loaded programs
    def check_init(func):
        """Wrapper for functions that require an initialized switch
        """
        # Note: args[0] is equal to self
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not args[0].tables is not None:
                logging.error(
                    "Tried to call {} but it requires an initialized switch. SwitchManager:{}".format(func,args[0].config))
                raise RuntimeError("Switch has no initialized pipeline")
            return func(*args, **kwargs)
        return wrapper

    def connect(self):
        """Connects manager to BMv2 switch over P4 runtime based on loaded config.
        """
        try:
            # Create connection to switch by unpacking config dict
            connection = dict(self.config)
            adapter_enabled = connection.pop("register_adapter_enabled", False)
            thrift_host = connection.pop("register_thrift_host", None)
            thrift_port = connection.pop("register_thrift_port", None)
            if not isinstance(adapter_enabled, bool):
                raise ValueError("register_adapter_enabled must be a boolean")
            if adapter_enabled:
                from .RegisterAdapter import RegisterAdapter
                self._register_adapter = RegisterAdapter(connection["address"], thrift_host, thrift_port, self.id)
                connection["address"] = self._register_adapter.address
                self.register_access.update(self._register_adapter.capabilities)
                self.register_access.update(mode="adapter", status="supported")
            self.bmv2 = Bmv2SwitchConnection(**connection)

            # Sets this controller as master controller
            # TODO: Better handling than just IF
            did_connect = self.bmv2.MasterArbitrationUpdate(deadline=0)

            if did_connect is None or did_connect.arbitration.status.code != 0:
                err_text = "Failed to connect to switch with config {}".format(self.config)
                logging.error(err_text) 
                raise Exception(err_text)
            else:
                self.connected = True
                from ..p4.v1 import p4runtime_pb2
                try:
                    capabilities = self.bmv2.client_stub.Capabilities(
                        p4runtime_pb2.CapabilitiesRequest(device_id=self.id), timeout=3)
                    self.p4runtime_api_version = capabilities.p4runtime_api_version
                    extension = Struct()
                    if capabilities.experimental.Unpack(extension):
                        fields = MessageToDict(extension)
                        if fields.get("source") == "unicorn-register-extension":
                            width = fields.get("max_bitwidth")
                            if (isinstance(width, bool) or not isinstance(width, (int, float))
                                    or int(width) != width or not 1 <= width <= 64
                                    or not isinstance(fields.get("read"), bool)
                                    or not isinstance(fields.get("write"), bool)):
                                raise ValueError("Malformed register capability metadata")
                            mode = "adapter" if self._register_adapter else "native"
                            self.register_access.update(mode=mode, source=mode, status="supported", available=True,
                                read=bool(fields.get("read")), write=bool(fields.get("write")),
                                max_bitwidth=int(fields["max_bitwidth"]), default_role_only=True)
                except RpcError:
                    # Older targets may omit Capabilities; arbitration is sufficient.
                    self.p4runtime_api_version = None
                except (ValueError, KeyError, TypeError, AttributeError):
                    # Capabilities are advisory; malformed optional extension
                    # metadata must not invalidate successful arbitration.
                    logging.warning("Target returned malformed register capability metadata")

        # Catch setup errors
        # TODO: raise exceptions or is logging enough?
        except RpcError as e:
            try:
                self.shutdown()
            except Exception as close_error:
                logging.warning("Cleanup after failed switch connection also failed: %s", close_error)
            err_text = "RPC error ocurred during switch setup: {}".format(
                e.debug_error_string())
            logging.error(err_text)
            raise Exception(err_text)
        except Exception as e:
            try:
                self.shutdown()
            except Exception as close_error:
                logging.warning("Cleanup after failed switch connection also failed: %s", close_error)
            err_text = "Error ocurred during switch setup: {}".format(str(e))
            logging.error(err_text)
            raise Exception(err_text)

    @check_connected
    #TODO: load p4 and bmv2 files once and pass content instead of paths
    def initialize(self,p4_file,bmv2_file,keep_entries=False):
        """Initializes switch with given files. Needs an active connection to switch.

        Args:
            p4_file (str): Path to P4 File
            bmv2_file (str): Path to BMv2 file
            keep_entries (bool, optional): Keep old table entries of switch. Defaults to False.
        """
        # Parse P4 config from file
        p4_helper = P4InfoHelper(p4_info_filepath=p4_file)
        # Apply new config to switch
        # TODO: causes error when device IDs mismatch
        #   There should be some handling here
        try:
            self.bmv2.SetForwardingPipelineConfig(
                p4info=p4_helper.p4info,
                bmv2_json_file_path=bmv2_file,
                keep_entries=keep_entries
            )
        except ValueError:
            raise
        except Exception as e:
            raise Exception("Could not configure switch, device ID mismatch? Check data plane logs (e.g. Mininet) for more information. Original Error: {}".format(e))
        # Store new config in internal storage
        self.p4_helper = p4_helper
        self.table_info = self.p4_helper.get_table_info()
        self.p4_file = p4_file
        self.bmv2_file = bmv2_file



        # Create manager for table requests
        self.tables = TableManager(self.bmv2,self.p4_helper)
        self._register_probe_done = False
        

    def shutdown(self):
        """Dismantles connection to BMv2 switch.
        """
        try:
            if self.bmv2 is not None:
                self.bmv2.shutdown()
        finally:
            try:
                if self._register_adapter is not None:
                    self._register_adapter.close()
            finally:
                self.connected = False


    def get_loaded_config(self):
        """Returns loaded P4 helper and table information.
        TODO: this has to be renamed/more clear what it does.
        """
        loaded_config = {}
        # Check for existing initialization
        if self.p4_helper is None:

            # Get P4 config from target switch
            p4_info = self.bmv2.GetForwardingPipelineConfig()

            # Check if config has been loaded
            if p4_info is not None:
                # BMv2 Switch has existing config, read P4 program and table information
                self.p4_helper = P4InfoHelper(p4_info_file=p4_info)
                self.tables = TableManager(self.bmv2, self.p4_helper)
                loaded_config["p4_info_helper"] = self.p4_helper
                loaded_config["table_info"] = self.p4_helper.get_table_info()
                loaded_config["counters"] = self.p4_helper.get_counters()
                loaded_config["direct_counters"] = self.p4_helper.get_direct_counters()
            else:
                # No config loaded, set keys to none
                loaded_config["p4_info_helper"] = None
                loaded_config["table_info"] = None
                loaded_config["counters"] = None
                loaded_config["direct_counters"] = None

            # All other fields are not read
            # TODO: why is this set here? Maybe it can be removed through refactoring
            loaded_config["p4_info_file"] = None
            loaded_config["bmv2_file"] = None
            loaded_config["state_id"] = None

        # Switch is already initialized, add fields to loaded config return
        # TODO: this function can be cleaned up via some _to_json function
        else:
            loaded_config["state_id"] = self.state_id
            loaded_config["p4_info_file"] = self.p4_file
            loaded_config["bmv2_file"] = self.bmv2_file
            loaded_config["p4_info_helper"] = self.p4_helper
            loaded_config["table_info"] = self.p4_helper.get_table_info()
            loaded_config["counters"] = self.p4_helper.get_counters()
            loaded_config["direct_counters"] = self.p4_helper.get_direct_counters()
        for key in ("registers", "meters", "direct_meters", "digests"):
            loaded_config[key] = getattr(self.p4_helper, "get_" + key)() if self.p4_helper is not None else None
        loaded_config["p4runtime_api_version"] = self.p4runtime_api_version
        self._probe_register_access()
        loaded_config["register_access"] = dict(self.register_access)
        return loaded_config

    def _probe_register_access(self):
        """Read one cell to discover external target support; never write a probe."""
        if self._register_probe_done or self.register_access["status"] == "supported" or self.p4_helper is None:
            return
        candidates = [register for register in self.p4_helper.p4info.registers
                      if register.size > 0 and register_type(register, self.p4_helper.p4info)["kind"] in ("bit", "int")
                      and 1 <= register_type(register, self.p4_helper.p4info).get("bitwidth", 0) <= 63]
        if not candidates:
            return
        from ..p4.v1 import p4runtime_pb2
        entity = p4runtime_pb2.Entity()
        entity.register_entry.register_id = candidates[0].preamble.id
        entity.register_entry.index.index = 0
        try:
            found = False
            for response in self.bmv2.ReadEntities([entity]):
                for actual in response.entities:
                    if (actual.WhichOneof("entity") == "register_entry"
                            and actual.register_entry.register_id == entity.register_entry.register_id
                            and actual.register_entry.HasField("index") and actual.register_entry.index.index == 0
                            and actual.register_entry.HasField("data")):
                        found = True
            if found:
                self.register_access.update(mode="native", source="native", status="supported", available=True, read=True)
                self._register_probe_done = True
        except RpcError as error:
            if error.code() == grpc.StatusCode.UNIMPLEMENTED:
                self.register_access.update(mode="unsupported", source="unsupported", status="unsupported",
                                            available=False, read=False, write=False)
                self._register_probe_done = True
            # A transient read error is not proof that the feature is unsupported.

    def as_json(self):
        """Get JSON representation for frontend.

        Returns:
            str: JSON representation
        """
        # TODO: where does db_id come from?
        data = {
                "name": self.bmv2.name,
                "address": self.config.get("address", self.bmv2.address),
                "device_id": self.bmv2.device_id,
                "proto_dump_file": self.bmv2.proto_dump_file,
                "db_id": self.db_id,
                "p4runtime_api_version": self.p4runtime_api_version,
                "register_access": dict(self.register_access),
                "register_adapter_enabled": self.config.get("register_adapter_enabled", False),
                "register_thrift_host": self.config.get("register_thrift_host"),
                "register_thrift_port": self.config.get("register_thrift_port")
            }
        return data
    
    @check_init
    def get_table_entries(self,name=None):
        return self.tables.get_entries(name)
    
    @check_init
    def create_table_entry(self,entry,is_json):
        # TODO: this could be done prettier?
        parsed_entry = TableEntry(self.p4_helper)
        if is_json:
            parsed_entry.from_json(entry)
        else:
            parsed_entry.from_dict(entry)
        return parsed_entry

    @check_init
    def write_table_entry(self,entry):
        entry_object = entry.get_entry_obj()

        m = entry_object.match
        # Iterate RepeatedCompositeFieldContainer
        # bytes("", 'latin1') is required to check if this is the corresponding matching type
        for m in entry_object.match:
            if m.lpm.value != bytes("", 'latin1'):
                # We have to bitwise AND value and prefix_len as the P4 Runtime will throw an error if prefix_len and value do not match up
                # Convert bytes to an integer
                int_value = int.from_bytes(m.lpm.value, byteorder='big')
                # Convert prefix_len to a mask
                p4info_match = self.p4_helper.get_match_field(table_name=entry.table_name, id=m.field_id)
                bitwidth = p4info_match.bitwidth
                
                if m.lpm.prefix_len > bitwidth:
                    raise ValueError("Prefix length exceeds bitwidth of field!")
                
                mask = int('1' * m.lpm.prefix_len + (bitwidth - m.lpm.prefix_len) * '0', 2)
                # Apply the LPM Mask         
                m.lpm.value = (int_value & mask).to_bytes(len(m.lpm.value), byteorder='big')
            elif m.ternary.value != bytes("", 'latin1'):
                int_value = int.from_bytes(m.ternary.value, byteorder='big')
                int_mask = int.from_bytes(m.ternary.mask, byteorder='big')
                m.ternary.value = (int_value & int_mask).to_bytes(len(m.ternary.value), byteorder='big')
            elif m.range.low != bytes("", 'latin1'):
                if m.range.low > m.range.high:
                    raise ValueError("Lower bound must be smaller than higher bound for a range match!")
                
        self.bmv2.WriteTableEntry(entry.get_entry_obj())

    def delete_table_entry(self, entry):
        self.bmv2.DeleteTableEntry(entry.get_entry_obj())

    def update_table_entry(self, old, new):
        # Only update if entries are different
        # TODO: add function for comparison


        # If entries match, delete if flag set
        # If entries match and flag not set, do nothing
        # A MODIFY without meter_config resets a direct meter. Preserve the
        # existing row's configuration explicitly, including when restoring it.
        from ..p4.v1 import p4runtime_pb2
        if any(m.direct_table_id == old.entry.table_id for m in self.p4_helper.p4info.direct_meters):
            selector = p4runtime_pb2.Entity()
            selector.direct_meter_entry.table_entry.CopyFrom(old.entry)
            selector.direct_meter_entry.table_entry.ClearField("action")
            for response in self.bmv2.ReadEntities([selector]):
                for entity in response.entities:
                    if entity.WhichOneof("entity") == "direct_meter_entry" and entity.direct_meter_entry.HasField("config"):
                        config = entity.direct_meter_entry.config
                        old.entry.meter_config.CopyFrom(config)
                        new.entry.meter_config.CopyFrom(config)
        if (getattr(new, "deleted", False) or old.match_fields != new.match_fields or old.priority != new.priority) and any(
                counter.direct_table_id == old.entry.table_id for counter in self.p4_helper.p4info.direct_counters):
            selector = p4runtime_pb2.Entity()
            selector.direct_counter_entry.table_entry.CopyFrom(old.entry)
            selector.direct_counter_entry.table_entry.ClearField("action")
            for response in self.bmv2.ReadEntities([selector]):
                for entity in response.entities:
                    if entity.WhichOneof("entity") == "direct_counter_entry":
                        old.entry.counter_data.CopyFrom(entity.direct_counter_entry.data)
        if getattr(new, "deleted", False):
            self.delete_table_entry(old)
        elif old.get_entry_obj() == new.get_entry_obj():
            return
        else:
            # IF entry match fields and priorities are the same, an update call can be used
            # Otherwise, delete old entry and write new one.
            if (old.match_fields == new.match_fields and old.priority == new.priority):
                self.bmv2.ModifyTableEntry(new.get_entry_obj())
            else:
                self.delete_table_entry(old)
                try:
                    self.write_table_entry(new)
                except Exception as error:
                    try:
                        self.write_table_entry(old)
                    except Exception as restore_error:
                        raise RuntimeError(f"{error}; restoring original entry also failed: {restore_error}") from error
                    raise
                
    def get_counter_values(self, counter_id=None, index=None):
        result = self.bmv2.ReadCounters(counter_id=counter_id, index=index)
        entries = {"counterID": counter_id, "entries": []}
        for r in result:
            for entity in r.entities:
                if entity.WhichOneof("entity") != "counter_entry":
                    continue
                entry = entity.counter_entry
                entries["entries"].append({"index": entry.index.index, "packets": str(entry.data.packet_count), "bytes": str(entry.data.byte_count)})
        return entries
    
    def get_direct_counter_values(self, table_id=None):
        result = self.bmv2.ReadDirectCounters(table_id=table_id)
        entries = {"table_id": table_id, "entries": []}
        for r in result:
            for entity in r.entities:
                if entity.WhichOneof("entity") != "direct_counter_entry":
                    continue
                entry = entity.direct_counter_entry
                entries["entries"].append({"key": table_entry_key(entry.table_entry),
                    "packets": str(entry.data.packet_count), "bytes": str(entry.data.byte_count)})
        return entries


def table_entry_key(entry):
    return (entry.table_id, entry.priority, entry.is_default_action,
            tuple(sorted(_match_key(match) for match in entry.match)))


def _match_key(match):
    kind = match.WhichOneof("field_match_type")
    body = getattr(match, kind)
    if kind in ("exact", "optional"):
        value = (int.from_bytes(body.value, "big"),)
    elif kind == "lpm":
        value = (int.from_bytes(body.value, "big"), body.prefix_len)
    elif kind == "ternary":
        value = (int.from_bytes(body.value, "big"), int.from_bytes(body.mask, "big"))
    elif kind == "range":
        value = (int.from_bytes(body.low, "big"), int.from_bytes(body.high, "big"))
    else:
        value = (match.SerializeToString(deterministic=True),)
    # P4Runtime accepts both shortest and padded bytestrings for the same
    # numeric match key; unrelated Read streams can choose either form.
    return match.field_id, kind, value
