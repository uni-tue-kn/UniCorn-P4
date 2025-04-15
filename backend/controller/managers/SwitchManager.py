from .TableManager import TableManager
from .TableEntry import TableEntry
import logging
from ..utils.bmv2 import Bmv2SwitchConnection
from ..utils.helper import P4InfoHelper
from grpc import RpcError
from google.protobuf.json_format import MessageToDict

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


    def check_connected(func):
        """Wrapper for functions that require a BMv2 connection
        """
        # Note: args[0] is equal to self
        def wrapper(*args):
            if not args[0].connected:
                logging.error(
                    "Tried to call {} but it requires a switch connection. SwitchManager:{}".format(func,args[0].config))
                return
            return func(*args)
        return wrapper
    
    # TODO: when switch has already loaded program, this crashes everything
    # Add fix for loaded programs
    def check_init(func):
        """Wrapper for functions that require an initialized switch
        """
        # Note: args[0] is equal to self
        def wrapper(*args):
            if not args[0].tables is not None:
                logging.error(
                    "Tried to call {} but it requires an initialized switch. SwitchManager:{}".format(func,args[0].config))
                return
            return func(*args)
        return wrapper

    def connect(self):
        """Connects manager to BMv2 switch over P4 runtime based on loaded config.
        """
        try:
            # Create connection to switch by unpacking config dict
            self.bmv2 = Bmv2SwitchConnection(**self.config)

            # Sets this controller as master controller
            # TODO: Better handling than just IF
            did_connect = self.bmv2.MasterArbitrationUpdate(deadline=0)

            if did_connect is None:
                err_text = "Failed to connect to switch with config {}".format(self.config)
                logging.error(err_text) 
                raise Exception(err_text)
            else:
                self.connected = True

        # Catch setup errors
        # TODO: raise exceptions or is logging enough?
        except RpcError as e:
            err_text = "RPC error ocurred during switch setup: {}".format(
                e.debug_error_string())
            logging.error(err_text)
            raise Exception(err_text)
        except Exception as e:
            err_text = "Error ocurred during switch setup: {}".format(
                e.debug_error_string())
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
        except Exception as e:
            raise Exception("Could not configure switch, device ID mismatch? Check data plane logs (e.g. Mininet) for more information. Original Error: {}".format(e))
        # Store new config in internal storage
        self.p4_helper = p4_helper
        self.table_info = self.p4_helper.get_table_info()
        self.p4_file = p4_file
        self.bmv2_file = bmv2_file



        # Create manager for table requests
        self.tables = TableManager(self.bmv2,self.p4_helper)
        

    def shutdown(self):
        """Dismantles connection to BMv2 switch.
        """
        self.bmv2.shutdown()


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
        return loaded_config

    def as_json(self):
        """Get JSON representation for frontend.

        Returns:
            str: JSON representation
        """
        # TODO: where does db_id come from?
        data = {
                "name": self.bmv2.name,
                "address": self.bmv2.address,
                "device_id": self.bmv2.device_id,
                "proto_dump_file": self.bmv2.proto_dump_file,
                "db_id": self.db_id
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
        if (old == new and old.priority == new.priority):
            if (new.deleted):
                self.delete_table_entry(old)
            else:
                logging.warn("Passed identical entries to update table entry function for switch {} - {}".format(old, new))
        else:
            # IF entry match fields and priorities are the same, an update call can be used
            # Otherwise, delete old entry and write new one.
            if (old.match_fields == new.match_fields and old.priority == new.priority):
                self.bmv2.ModifyTableEntry(new.get_entry_obj())
            else:
                self.delete_table_entry(old)
                self.write_table_entry(new)
                
    def get_counter_values(self, counter_id=None, index=None):
        result = self.bmv2.ReadCounters(counter_id=counter_id, index=index)
        for r in result:
            counter_dict = MessageToDict(r)
            entries = {"counterID": counter_dict["entities"][0]['counterEntry']['counterId'], "entries": []}
            for e in counter_dict["entities"]:
                index = e['counterEntry']['index'].get('index', 0)
                packets = e['counterEntry']['data'].get('packetCount', 0)
                bytes = e['counterEntry']['data'].get('byteCount', 0)
                entry = {"index": index, "packets": packets, "bytes": bytes}
                entries["entries"].append(entry)
        return entries
    
    def get_direct_counter_values(self, table_id=None):
        result = self.bmv2.ReadDirectCounters(table_id=table_id)
        for r in result:
            entries = {"table_id": table_id, "entries": []}
            counter_dict = MessageToDict(r)
            if "entities" in counter_dict.keys():
                for e in counter_dict["entities"]:
                    match = e['directCounterEntry']['tableEntry']['match']
                    packets = e['directCounterEntry']['data'].get('packetCount', 0)
                    bytes = e['directCounterEntry']['data'].get('byteCount', 0)
                    entry = {"match": match, "packets": packets, "bytes": bytes}
                    entries["entries"].append(entry)
        return entries
    