"""Lossless, JSON-safe P4Data decoding using the program's P4Info types."""
from ..p4.config.v1 import p4types_pb2


def _raw(data):
    return {'kind': 'raw', 'protobuf_hex': data.SerializeToString().hex()}


def _bits(raw, spec=None, width=None):
    kind = spec.WhichOneof('type_spec') if spec is not None else 'bit'
    if width is None and kind in ('bit', 'int'):
        width = getattr(spec, kind).bitwidth if spec is not None else len(raw) * 8
    result = {'kind': kind or 'bit', 'decimal': str(int.from_bytes(raw, 'big', signed=kind == 'int')),
              'hex': '0x' + raw.hex()}
    if width is not None:
        result['bitwidth'] = width
    return result


def decode_p4data(data, spec=None, type_info=None, depth=0):
    # Malformed/cyclic type descriptions and deeply nested data remain available
    # losslessly as protobuf bytes instead of exhausting the API worker's stack.
    if depth >= 16:
        return _raw(data)
    expected = spec.WhichOneof('type_spec') if spec is not None else None
    if expected == 'new_type' and type_info is not None:
        name = spec.new_type.name
        if name in type_info.new_types:
            definition = type_info.new_types[name]
            if definition.HasField('original_type'):
                return decode_p4data(data, definition.original_type, type_info, depth + 1)
        return _raw(data)
    kind = data.WhichOneof('data')
    if kind == 'bitstring':
        return _bits(data.bitstring, spec.bitstring if expected == 'bitstring' else None)
    if kind == 'varbit':
        result = _bits(data.varbit.bitstring, width=data.varbit.bitwidth)
        result['kind'] = 'varbit'
        return result
    if kind == 'bool':
        return {'kind': 'bool', 'value': getattr(data, 'bool')}
    if kind in ('enum', 'error'):
        return {'kind': kind, 'value': getattr(data, kind)}
    if kind == 'enum_value':
        result = _bits(data.enum_value)
        result['kind'] = 'serializable_enum'
        if expected == 'serializable_enum' and type_info is not None:
            name = spec.serializable_enum.name
            if name in type_info.serializable_enums:
                definition = type_info.serializable_enums[name]
                result['bitwidth'] = definition.underlying_type.bitwidth
                for member in definition.members:
                    if int.from_bytes(member.value, 'big') == int(result['decimal']):
                        result['name'] = member.name
                        break
        return result
    if kind in ('struct', 'tuple'):
        members = getattr(data, kind).members
        if len(members) > 256:
            return _raw(data)
        if kind == 'struct' and expected == 'struct' and type_info is not None:
            name = spec.struct.name
            if name in type_info.structs:
                definitions = type_info.structs[name].members
                if len(definitions) == len(members):
                    return {'kind': 'struct', 'name': name,
                            'fields': {member.name: decode_p4data(value, member.type_spec, type_info, depth + 1)
                                       for member, value in zip(definitions, members)}}
        definitions = spec.tuple.members if expected == 'tuple' else []
        return {'kind': kind, 'members': [decode_p4data(value, definitions[index] if index < len(definitions)
                else None, type_info, depth + 1) for index, value in enumerate(members)]}
    if kind == 'header':
        header = data.header
        if not header.is_valid:
            return {'kind': 'header', 'valid': False} if not header.bitstrings else _raw(data)
        if expected == 'header' and type_info is not None and spec.header.name in type_info.headers:
            definitions = type_info.headers[spec.header.name].members
            if len(definitions) == len(header.bitstrings) and len(definitions) <= 256:
                return {'kind': 'header', 'valid': True, 'name': spec.header.name,
                        'fields': {member.name: _bits(value, member.type_spec)
                                   for member, value in zip(definitions, header.bitstrings)}}
        return {'kind': 'header', 'valid': True, 'fields': [_bits(value) for value in header.bitstrings]}
    if kind == 'header_union':
        union = data.header_union
        if not union.valid_header_name:
            return {'kind': 'header_union', 'valid_header_name': None} if not union.HasField('valid_header') else _raw(data)
        header_spec = None
        if expected == 'header_union' and type_info is not None and spec.header_union.name in type_info.header_unions:
            for member in type_info.header_unions[spec.header_union.name].members:
                if member.name == union.valid_header_name:
                    header_spec = p4types_pb2.P4DataTypeSpec()
                    header_spec.header.CopyFrom(member.header)
                    break
        header_data = type(data)()
        header_data.header.CopyFrom(union.valid_header)
        return {'kind': 'header_union', 'valid_header_name': union.valid_header_name,
                'value': decode_p4data(header_data, header_spec, type_info, depth + 1)}
    if kind in ('header_stack', 'header_union_stack'):
        values = getattr(data, kind).entries
        if len(values) > 256:
            return _raw(data)
        member_kind = 'header' if kind == 'header_stack' else 'header_union'
        member_spec = None
        if expected == kind:
            member_spec = p4types_pb2.P4DataTypeSpec()
            getattr(member_spec, member_kind).CopyFrom(getattr(getattr(spec, kind), member_kind))
        decoded = []
        for value in values:
            member_data = type(data)()
            getattr(member_data, member_kind).CopyFrom(value)
            decoded.append(decode_p4data(member_data, member_spec, type_info, depth + 1))
        return {'kind': kind, 'entries': decoded}
    return _raw(data)
