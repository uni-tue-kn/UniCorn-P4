"""Additive compatibility migrations for existing teaching/deployment databases."""
from sqlalchemy import inspect, text


def migrate_switch_adapter_fields(engine):
    additions = {
        "target": "VARCHAR NOT NULL DEFAULT 'bmv2'",
        "target_options": "JSON",
        "register_adapter_enabled": "BOOLEAN NOT NULL DEFAULT 0",
        "register_thrift_host": "VARCHAR",
        "register_thrift_port": "INTEGER",
    }
    with engine.begin() as connection:
        inspector = inspect(connection)
        for table, fields in (("SwitchConfigs", additions), ("TableStates", {
                "target": "VARCHAR NOT NULL DEFAULT 'bmv2'", "program_manifest": "VARCHAR", "program_name": "VARCHAR"})):
            if not inspector.has_table(table):
                continue
            columns = {column["name"] for column in inspector.get_columns(table)}
            for name, definition in fields.items():
                if name not in columns:
                    connection.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {definition}'))
