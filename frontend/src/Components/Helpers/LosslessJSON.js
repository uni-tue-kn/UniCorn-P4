import JSONbig from 'json-bigint';

const parser = JSONbig({ storeAsString: true });
export function parseLosslessJSON(data) {
  if (typeof data !== 'string') return data;
  try { return parser.parse(data); }
  catch { return data; }
}
