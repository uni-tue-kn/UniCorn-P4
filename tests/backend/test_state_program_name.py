import sqlite3

from sqlalchemy import inspect, text


def test_program_name_migration_preserves_old_saved_states_and_is_idempotent(tmp_path, monkeypatch):
    path = tmp_path / 'legacy-state.db'
    with sqlite3.connect(path) as connection:
        connection.executescript('''
            CREATE TABLE TableStates (
                id INTEGER PRIMARY KEY, p4_info_file VARCHAR NOT NULL, bmv2_file VARCHAR NOT NULL,
                table_entries JSON, decoding JSON, table_info JSON, date_created DATETIME,
                last_init DATETIME, location VARCHAR NOT NULL, initial_state_id INTEGER,
                name VARCHAR, switch_config_id INTEGER);
            INSERT INTO TableStates VALUES (17, '/p4/basic.p4info.txt', '/p4/basic.json', '{}', '{}', '{}',
                '2026-11-01 12:00:00', '2026-11-01 12:00:00', 'saved', NULL, 'Lecture', NULL);
        ''')
    monkeypatch.setenv('DB_DIR', str(path))
    monkeypatch.setenv('UPDATE_CHECK_ENABLED', 'false')
    from api import create_app
    from api.database import db
    from api.database.migrations import migrate_switch_adapter_fields
    app = create_app()
    with app.app_context():
        migrate_switch_adapter_fields(db.engine)
        migrate_switch_adapter_fields(db.engine)
        assert 'program_name' in {column['name'] for column in inspect(db.engine).get_columns('TableStates')}
        old = db.session.execute(text('SELECT id, name, p4_info_file, target, program_name FROM TableStates')).one()
        assert tuple(old) == (17, 'Lecture', '/p4/basic.p4info.txt', 'bmv2', None)
    saved = app.test_client().get('/saved').json[0]
    assert saved['id'] == 17 and saved['name'] == 'Lecture'
    assert saved['program_name'] is None
    assert saved['bmv2_file'] == '/p4/basic.json'


def test_native_program_name_survives_saved_state_copy_update_and_extract(app):
    from api.database import db
    from api.database.TableStates import TableStates, copy_state, update_state, extractStateData
    with app.app_context():
        original = TableStates(target='tofino', program_name='workshop', program_manifest='/p4/build/manifest.json',
                               p4_info_file='', bmv2_file='', name='Workshop state')
        db.session.add(original)
        db.session.commit()
        copied = copy_state(original)
        copied.location = 'saved'
        db.session.add(copied)
        db.session.commit()
        assert extractStateData([copied])[0]['program_name'] == 'workshop'
        original.program_name = 'routing'
        update_state(copied, original)
        db.session.commit()
        assert copied.program_name == 'routing'
        assert copied.target == 'tofino'
        assert copied.program_manifest == '/p4/build/manifest.json'
