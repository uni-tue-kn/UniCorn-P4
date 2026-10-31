import pytest


def write(root, *names):
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{}')


def listing(client, monkeypatch, root):
    # A trailing slash is intentionally absent.
    monkeypatch.setenv('P4_DIR', str(root))
    response = client.get('/p4files')
    assert response.status_code == 200
    return response.get_json()


@pytest.mark.parametrize('suffix', ['.p4info.txt', '.p4info.txtpb', '.p4info.pb.txt'])
def test_compiled_program_pairs_sibling_files_and_includes_source(client, monkeypatch, tmp_path, suffix):
    root = tmp_path / 'p4'
    write(root, 'p4-tutorial/tutorial.json', 'p4-tutorial/tutorial' + suffix,
          'p4-tutorial/tutorial.p4')
    result = listing(client, monkeypatch, root)
    program = root / 'p4-tutorial/tutorial'
    assert result == {
        'p4_info': [str(program) + suffix],
        'bmv2': [str(program) + '.json'],
        'programs': [{'id': str(program) + '.json', 'name': 'p4-tutorial/tutorial',
                      'p4_info': str(program) + suffix, 'bmv2': str(program) + '.json',
                      'source': str(program) + '.p4'}],
    }


def test_compiled_pair_does_not_require_source_or_inspect_json_contents(client, monkeypatch, tmp_path):
    root = tmp_path / 'p4'
    write(root, 'compiled.json', 'compiled.p4info.txt')
    result = listing(client, monkeypatch, root)
    assert result['programs'][0]['source'] is None
    assert result['programs'][0]['name'] == 'compiled'


def test_ambiguous_p4info_pair_stays_available_for_manual_selection(client, monkeypatch, tmp_path):
    root = tmp_path / 'p4'
    write(root, 'basic.json', 'basic.p4info.txt', 'basic.p4info.txtpb', 'notes.txt')
    result = listing(client, monkeypatch, root)
    assert result['programs'] == []
    assert result['bmv2'] == [str(root / 'basic.json')]
    assert result['p4_info'] == sorted(str(root / name) for name in
                                    ('basic.p4info.txt', 'basic.p4info.txtpb', 'notes.txt'))


def test_unmatched_files_are_not_guessed_across_directories_or_names(client, monkeypatch, tmp_path):
    root = tmp_path / 'p4'
    write(root, 'a/basic.json', 'b/basic.p4info.txt', 'a/other.p4info.txt',
          'standalone.json', 'topology.json', 'sub/topology.json')
    result = listing(client, monkeypatch, root)
    assert result['programs'] == []
    assert result['bmv2'] == [str(root / 'a/basic.json'), str(root / 'standalone.json')]
    assert len(result['p4_info']) == 2


def test_duplicate_basenames_have_distinct_ids_and_relative_names(client, monkeypatch, tmp_path):
    root = tmp_path / 'p4'
    write(root, 'z/basic.json', 'z/basic.p4info.txt', 'a/basic.json', 'a/basic.p4info.txt')
    result = listing(client, monkeypatch, root)
    assert [program['name'] for program in result['programs']] == ['a/basic', 'z/basic']
    assert len({program['id'] for program in result['programs']}) == 2
    assert result['bmv2'] == sorted(result['bmv2'])
    assert result['p4_info'] == sorted(result['p4_info'])


def test_outside_symlinks_cannot_supply_program_files_or_sources(client, monkeypatch, tmp_path):
    root = tmp_path / 'p4'
    outside = tmp_path / 'private'
    write(outside, 'secret.json', 'secret.p4info.txt', 'secret.p4')
    write(root, 'valid.json', 'valid.p4info.txt', 'missing-source.json', 'missing-source.p4info.txt')
    (root / 'outside').symlink_to(outside, target_is_directory=True)
    (root / 'secret.json').symlink_to(outside / 'secret.json')
    (root / 'secret.p4info.txt').symlink_to(outside / 'secret.p4info.txt')
    (root / 'missing-source.p4').symlink_to(outside / 'secret.p4')
    (root / 'valid.p4').symlink_to(root / 'missing-source.json')
    (root / 'cycle').symlink_to(root, target_is_directory=True)
    (root / 'broken.json').symlink_to(root / 'absent.json')
    result = listing(client, monkeypatch, root)
    assert [program['name'] for program in result['programs']] == ['missing-source', 'valid']
    assert result['programs'][0]['source'] is None
    assert result['programs'][1]['source'] == str(root / 'valid.p4')
    assert result['bmv2'] == sorted(str(root / name) for name in ('missing-source.json', 'valid.json'))
    assert result['p4_info'] == sorted(str(root / name) for name in
                                    ('missing-source.p4info.txt', 'valid.p4info.txt'))


def test_missing_directory_returns_empty_lists(client, monkeypatch, tmp_path):
    assert listing(client, monkeypatch, tmp_path / 'missing') == {
        'programs': [], 'p4_info': [], 'bmv2': []}
