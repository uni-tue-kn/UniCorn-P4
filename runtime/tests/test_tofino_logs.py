from runtime.tofino.supervisor import trim_log


def test_log_trimming_keeps_recent_output_and_append_writer(tmp_path):
    path = tmp_path / 'switch.log'
    with path.open('ab', buffering=0) as writer:
        writer.write(b'old output\n' + b'x' * 100 + b'recent output\n')
        trim_log(path, limit=100)
        assert path.stat().st_size == 50
        assert path.read_bytes().endswith(b'recent output\n')
        writer.write(b'new output\n')
        assert path.read_bytes().endswith(b'recent output\nnew output\n')
        assert path.stat().st_size == 61


def test_missing_and_small_logs_are_left_alone(tmp_path):
    path = tmp_path / 'switch.log'
    trim_log(path)
    assert not path.exists()
    path.write_text('small log')
    trim_log(path)
    assert path.read_text() == 'small log'
