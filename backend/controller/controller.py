#!/usr/bin/env python3

# NOTICE: THIS FILE IS BASED ON https://github.com/p4lang/tutorials/tree/master/exercises/p4runtime

from .managers.SwitchManager import SwitchManager

from .utils.helper import P4InfoHelper
import grpc

class UpdateError(Exception):
    def __init__(self, e, id):
        self.e = e
        self.id = id

# TODO: no type checking at all ._. at least some should be done at this level
class Controller:
    def __init__(self):
        # TODO: change to switch_managers
        self.switch_configs = {}

    def getSwitchConnections(self):
        """Returns internal dict of configured switches containing name, addresses, etc.

        Returns:
            dict: Configured Switches
        """
        switch_list = []
        for key, switch in self.switch_configs.items():
            switch_list.append(switch.as_json())

        return switch_list

    def addSwitchConnection(self, switch_config):
        """Instantiates connection to a new switch based on passed configuration.

        Args:
            switch_config (dict): config dictionary

        Raises:
            Exception: Error during switch connection setup
            Exception: Duplicate device_id found
        """
        id = switch_config["device_id"]

        # Check that no connection with same id exists already
        if self.switch_configs.get(id) is None:

            new_switch = SwitchManager(id,switch_config)
            # If this fails, then error will be logged and switch.connected will be set to false
            try:
                new_switch.connect()
            except Exception as e:
                print("Could not connect")
                raise e

            # TODO: catch here if new_switch is not connected?
            self.switch_configs[id] = new_switch

        else:
            # Catch error that switch is already configured, caused by duplicate IDs
            raise Exception(
                "This device_id is already assigned to another Switch Connection! Each device_id has to be unique!")

    def deleteSwitchConnection(self, switch_id):
        """Stops an active switch connection and removes its reference from internal storage.

        Args:
            switch_id (int): ID of device to delete
        """
        # Stop switch
        self.switch_configs[switch_id].shutdown()
        # Remove reference
        del self.switch_configs[switch_id]

    def initialize(self, switch_id, p4_info_file, bmv2_file, keep_entries):
        """Initializes switch with given config.
        TODO: More is going on here, check later

        Args:
            switch_id (int): ID of target switch
            p4_info_file (str): Path to P4 info file
            bmv2_file (str): Path to BMv2 file
            keep_entries (bool): Keep table entries on update
        """
        # Get switch manager
        target_switch = self.switch_configs[switch_id]
        # Initialize switch
        # TODO: Paths are determined in frontend? Find out where and remove this patch
        target_switch.initialize(p4_info_file,bmv2_file,keep_entries)


    def getInitializedFiles(self, switch_id):
        """Returns information set during switch initialization.

        Args:
            switch_id (int): ID of target switch

        Returns:
            dict: Switch config dict, e.g. p4 file path, bmv2 file path
        """
        print(self.switch_configs)
        target_switch = self.switch_configs[switch_id]
        config = target_switch.get_loaded_config()

        # Return entire switch config dict except fields bmv2_connection and p4_info_helper
        return {
            k: v for k, v in config.items()
            if k != "bmv2_connection" and k != "p4_info_helper"
        }

    def getTableBlueprint(self, p4_info_file):
        """Returns a blueprint dict for all tables of a P4 program.
        Keys represent the table names and values are lists of table entries to write.
        The lists are empty when returned by thsi function.

        Args:
            p4_info_file (str): Path to P4 file

        Returns:
            dict: Table names dict with empty lists
        """
        # Get helper object from file
        p4info_helper = P4InfoHelper(p4_info_file)
        # Get dict of table names through P4 helper
        blueprint = p4info_helper.table_entry_blueprint()
        return blueprint

    def getInitialDecoding(self, switch_id, p4_info_file=None):
        """Returns a dict containing the decoded match and actions for each table.
        Keys are table names, values a dict {"match": ..., "action":...}

        Args:
            switch_id (int): ID of target switch
            p4_info_file (str, optional): Path to P4 file. Defaults to None, in which case the decoding is read from the runnign config

        Returns:
            dict: Decoding containing table names keys and match action information.
        """
        # Check if infor should be read from file or parsed from internal storage
        if p4_info_file is not None:
            # Get table reference from file
            p4_helper = P4InfoHelper(p4_info_file)
        else:
            # Get table reference from config
            target_switch = self.switch_configs[switch_id]
            p4_helper = target_switch.p4_helper

        # Return the stored decoding
        decoding = p4_helper.get_table_decoding()
        return decoding

    def getTableInfo(self, switch_id):
        """Returns dict of table match fields and action parameters information for all tables.

        Args:
            switch_id (int): ID of target switch

        Returns:
            dict: Field and action parameters for all tables.
        """
        target_switch = self.switch_configs[switch_id]
        return target_switch.p4_helper.get_table_info()

    def getTableEntries(self, switch_id, requested_table_name):
        """Returns all current entries stored in a switch table.

        Args:
            switch_id (int): ID of target switch
            requested_table_name (str): Name of target table, if None then all tables are read.

        Returns:
            list(dict): List of table entries with ID and fields.
        """

        # Get P4 program helper object for configured switch
        target_switch = self.switch_configs[switch_id]
        return target_switch.get_table_entries(requested_table_name)

    def createTableEntry(self, switch_id, entry, is_json=True):
        """Creates a table entry to the given switch table. DOES NOT write the entry.

        Args:
            switch_id (int): ID of target switch
            entry (json|obj): Entry to create object for.
            is_json (bool, optional): Parse entry as JSON or use as dict. Defaults to True.

        Returns:
            obj: Table entry object from P4 helper
        """
        target_switch = self.switch_configs[switch_id]
        return target_switch.create_table_entry(entry,is_json)

    def postTableEntry(self, switch_id, entry, is_json=True):
        """Creates and writes a table entry to the given switch.

        Args:
            switch_id (int): ID of traget switch
            entry (json|obj): Entry data to write
            is_json (bool, optional): Parse entry data from JSON. Defaults to True.
        """
        table_entry = self.createTableEntry(switch_id, entry, is_json)
        self.switch_configs[switch_id].write_table_entry(table_entry)

    def removeTableEntry(self, switch_id, entry):
        """Deletes a table entry from the given switch.

        Args:
            switch_id (int): ID of traget switch
            entry (obj): Entry object to delete
        """
        table_entry = self.createTableEntry(switch_id, entry)
        self.switch_configs[switch_id].delete_table_entry(table_entry)

    def patchTableEntry(self, switch_id, old_entry_dict, new_entry_dict):
        """Replaces table entry with given entry.

        Args:
            switch_id (int): ID of target switch
            old_entry_dict (dict): Entry to delete
            new_entry_dict (dict): Entry to write
        """

        # Create switch entry objects
        old_entry = self.createTableEntry(switch_id, old_entry_dict, False)
        new_entry = self.createTableEntry(switch_id, new_entry_dict, False)

        # Get connection reference
        target_switch = self.switch_configs[switch_id]

        # Apply update
        target_switch.update_table_entry(old_entry,new_entry)

    def updateTableEntries(self, switch_id, old_entries_list, new_entries_list):
        """Update multiple switch table entries. Same as pathTableEntry but with lists as input.

        Args:
            switch_id (int): ID of target switch
            old_entries_list (list(dict)): List of old entries to update
            new_entries_list (list(dict)): List of new entries

        Raises:
            UpdateError: gRPG calls failed
            UpdateError: Any other error that may be caused
        """
        # Iterate over all entries to update
        for i in range(0, len(old_entries_list)):

            # Try to update entry
            # TODO: this should be replaced with calls to patchTableEntry
            # TODO: reduce size of try block
            try:
                old_entry_dict = old_entries_list[i]
                entry_id = old_entry_dict["id"]

                # Get next item from new_entries_list where id of old entry matches the id of item
                new_entry_dict = next(
                    filter(lambda entry: entry["id"] == entry_id, new_entries_list))

                self.patchTableEntry(switch_id, old_entry_dict["switch_entry"], new_entry_dict["switch_entry"])

            # Catch any error that comes from RPC calls to switch
            except grpc.RpcError as e:
                # If no details are given, create custom message with possible reason
                if e.details() == "":
                    error = str(e.code(
                    )) + ": " + "An unknown grpc error occurred. Maybe an entry you tried to write has the same match values as an existing entry."
                    raise UpdateError(error, entry_id)
                else:
                    raise UpdateError(str(e.code()) + ": " +
                                      e.details(), entry_id)
            # Catch any other error
            except Exception as e:
                raise (UpdateError(str(e), entry_id))