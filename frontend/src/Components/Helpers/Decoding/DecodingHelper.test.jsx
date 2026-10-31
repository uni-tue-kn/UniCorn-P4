import { describe, it, expect } from 'vitest';
import { decodeTableEntries, encodeNumerics, encodeNumericsArray } from './DecodingHelper';

const info = { t: { match_fields: { key: { match_type: 2 } }, actions: {} } };
const decoding = { t: { match: { key: 'hexadecimal' }, action: { a: { p: 'binary' } } } };
const entry = { table_name: 't', match_fields: { key: '18446744073709551615' }, action_name: 'a', action_params: { p: '9007199254740993' }, priority: null };
describe('table numeric decoding', () => {
  it('round-trips wide values without mutating fetched table state', () => {
    const entries = [{ id: 1, switch_entry: structuredClone(entry) }];
    const decoded = decodeTableEntries(entries, decoding, info, 't');
    expect(decoded[0].switch_entry.match_fields.key).toBe('ffffffffffffffff');
    expect(entries[0].switch_entry).toEqual(entry);
    expect(encodeNumerics(decoded[0].switch_entry, decoding, info, 't')).toEqual(entry);
    expect(decoded[0].switch_entry.match_fields.key).toBe('ffffffffffffffff');
  });
  it('keeps batch edit snapshots independent', () => {
    const entries = [{ id: 1, switch_entry: { ...entry, match_fields: { key: 'ff' }, action_params: {} } }];
    const encoded = encodeNumericsArray(entries, decoding, info, 't');
    expect(encoded[0].switch_entry.match_fields.key).toBe('255');
    expect(entries[0].switch_entry.match_fields.key).toBe('ff');
  });
});
