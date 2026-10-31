"""Additive compatibility migrations for existing teaching/deployment databases."""
from sqlalchemy import inspect, text


def migrate_switch_adapter_fields(engine):
    additions = {
        "register_adapter_enabled": "BOOLEAN NOT NULL DEFAULT 0",
        "register_thrift_host": "VARCHAR",
        "register_thrift_port": "INTEGER",
    }
    with engine.begin() as connection:
        inspector = inspect(connection)
        if not inspector.has_table("SwitchConfigs"):
            return
        columns = {column["name"] for column in inspector.get_columns("SwitchConfigs")}
        for name, definition in additions.items():
            if name not in columns:
                connection.execute(text(f'ALTER TABLE "SwitchConfigs" ADD COLUMN "{name}" {definition}'))
