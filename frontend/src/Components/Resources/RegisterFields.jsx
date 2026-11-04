import React from 'react';
import { Button, MenuItem, Stack, TextField } from '@mui/material';

export const registerFields = resource => resource.fields?.length ? resource.fields : [{ name: 'value', label: 'Value', type: resource.type || { kind: 'bit', bitwidth: resource.bitwidth || 32 } }];
export const registerFieldValue = (entry, field) => entry.value != null && typeof entry.value === 'object' && !Array.isArray(entry.value) ? entry.value[field.name] : entry.value;
export const registerDraft = (entry, fields) => Object.fromEntries(fields.map(field => {
  const value = registerFieldValue(entry, field);
  return [field.name, Array.isArray(value) ? value.map(String) : String(value ?? '')];
}));

function typedValue(value, type) {
  if (type.kind === 'string') return String(value);
  if (type.kind === 'bool') {
    if (value !== 'true' && value !== 'false') throw new Error('Choose true or false.');
    return value === 'true';
  }
  if (type.kind === 'float') {
    if (!String(value).trim() || !Number.isFinite(Number(value))) throw new Error('Enter a finite number.');
    return Number(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error('Enter a whole number in decimal.');
  const integer = BigInt(value), width = BigInt(type.bitwidth || 32), signed = type.kind?.startsWith('int');
  const minimum = signed ? -(1n << (width - 1n)) : 0n;
  const maximum = (1n << (signed ? width - 1n : width)) - 1n;
  if (integer < minimum || integer > maximum) throw new Error(`Value must be between ${minimum} and ${maximum}.`);
  return integer.toString();
}
export function registerWriteValue(entry, fields, draft) {
  const values = Object.fromEntries(fields.map(field => {
    const type = field.type || field;
    return [field.name, type.repeated ? draft[field.name].map(value => typedValue(value, type)) : typedValue(draft[field.name], type)];
  }));
  return fields.length === 1 && (entry.value == null || typeof entry.value !== 'object' || Array.isArray(entry.value)) ? values[fields[0].name] : values;
}
export function displayRegisterValue(value, radix, type = {}) {
  if (Array.isArray(value)) return value.map(item => displayRegisterValue(item, radix, type)).join(', ');
  if (type.kind === 'string') return String(value);
  if (typeof value === 'boolean') return String(value);
  try { return BigInt(value).toString(Number(radix)); } catch { return String(value ?? '—'); }
}

export function RegisterFieldInput({ field, value, index, disabled, onChange }) {
  const type = field.type || field;
  const values = type.repeated ? value : [value];
  return <Stack spacing={1}>
    {values.map((item, position) => <TextField key={position} size="small" select={type.kind === 'bool' || Boolean(type.choices?.length)} disabled={disabled || field.read_only} label={`${field.label || field.name} for index ${index}${type.repeated ? ` [${position}]` : ''}`} value={item} helperText={type.kind === 'bool' ? 'true or false' : type.kind === 'string' ? 'Text' : type.kind === 'float' ? 'Finite number' : 'Decimal integer'} onChange={event => onChange(type.repeated ? values.map((old, ordinal) => ordinal === position ? event.target.value : old) : event.target.value)}>{(type.kind === 'bool' ? ['true', 'false'] : type.choices || []).map(option => <MenuItem key={option} value={option}>{option}</MenuItem>)}</TextField>)}
    {type.repeated && !field.read_only && <Stack direction="row" spacing={1}><Button disabled={disabled} onClick={() => onChange([...values, type.kind === 'bool' ? 'false' : type.kind === 'string' ? '' : '0'])}>Add {field.name} value</Button><Button disabled={disabled || !values.length} onClick={() => onChange(values.slice(0, -1))}>Remove last value</Button></Stack>}
  </Stack>;
}
