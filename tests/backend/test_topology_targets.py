import pytest

from api.topology_schema import validate_topology, validate_deployable_topology


def test_legacy_and_mixed_switch_properties_roundtrip():
    topology = {'hosts': [], 'switches': {'s1': {}, 's2': {'target': 'tofino', 'program': 'saved-build'}},
                'links': [['s1', 's2', '5ms', 10]]}
    assert validate_deployable_topology(topology) == topology
    assert topology['switches']['s1'] == {}
    assert topology['switches']['s2']['program'] == 'saved-build'


@pytest.mark.parametrize('target', [None, 'other', 1, [], {}])
def test_invalid_target_rejected(target):
    with pytest.raises(ValueError, match='Switch target'):
        validate_topology({'hosts': [], 'switches': {'s1': {'target': target}}, 'links': []})


def test_model_single_pipe_port_limit_includes_external_interfaces():
    topology = {'hosts': [], 'switches': {'s1': {'target': 'tofino'}, 's2': {}},
                'links': [['s1', 's2']] * 64, 'ext_intfs': [['s1', 'physical1']]}
    assert validate_topology(topology) == topology
    with pytest.raises(ValueError, match='at most 64 ports'):
        validate_deployable_topology(topology)


def test_disconnected_model_is_a_valid_draft_but_requires_an_interface_before_deployment():
    topology = {'hosts': [], 'switches': {'s1': {'target': 'tofino'}}, 'links': []}
    assert validate_topology(topology) == topology
    with pytest.raises(ValueError, match='Tofino switch s1 requires at least one interface'):
        validate_deployable_topology(topology)
    topology['ext_intfs'] = [['s1', 'physical1']]
    assert validate_deployable_topology(topology) == topology
    topology['switches']['s1'] = {}
    topology['ext_intfs'] = []
    assert validate_deployable_topology(topology) == topology
