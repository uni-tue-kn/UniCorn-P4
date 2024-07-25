from .TableEntry import TableEntry

class TableManager:
    # TODO: refactor to pass dataclass here
    def __init__(self, bmv2, p4_helper):
        self.bmv2 = bmv2
        self.p4_helper = p4_helper
        return

    def get_entries(self, name=None):
        # Create data structure for results
        if name is None:
            # Create dict with all table names
            data = self.p4_helper.table_entry_blueprint()
        else:
            data = {name: []}

        # TODO: whis is this always 4 instances for response?
        entry_collection = self.bmv2.ReadTableEntries()
        # Get ALL entries from switch
        for response in entry_collection:
            for entity in response.entities:

                raw_entry = entity.table_entry
                table_id = raw_entry.table_id

                # Get name of entities associated table
                table_name = self.p4_helper.get_tables_name(table_id)

                # If entity does not belong to requested table, skip it
                if ((name is not None) and (name != table_name)):
                    continue

                # Else parse entry
                entry = TableEntry(self.p4_helper)
                entry.from_entity(table_name,entity)

                # Add entry to data structure
                data[table_name].append(
                    {
                        # ID starts at 1 for first entry
                        "id": len(data[table_name]) + 1,
                        "switch_entry": entry.as_json()
                    }
             )
        return data





