export const meterFields = [['cir', 'CIR'], ['cburst', 'CBS'], ['pir', 'PIR'], ['pburst', 'PBS']];
export const DEFAULT_METER_DESCRIPTION = 'No rate configuration is set, so the meter marks every packet green without an explicit rate limit. The P4 program decides how to handle green packets. Reset restores this unconfigured state; explicit zero rates are a different configuration.';

export function meterUnit(resource) {
  if (resource?.burst_unit === 'kilobits') return 'kilobits';
  if (resource?.burst_unit === 'packets') return 'packets';
  const unit = resource?.unit ?? resource?.spec?.unit;
  if (unit === 1 || unit === 'BYTES') return 'bytes';
  if (unit === 2 || unit === 'PACKETS') return 'packets';
  return 'units';
}

export function meterFieldInfo(key, resource) {
  const quantity = meterUnit(resource);
  const rate = key === 'cir' || key === 'pir';
  const title = meterFields.find(([field]) => field === key)?.[1] || key;
  const names = { cir: 'Committed information rate', cburst: 'Committed burst size',
    pir: 'Peak information rate', pburst: 'Peak burst size' };
  const explanation = { cir: 'Sustained token refill rate for committed traffic.',
    cburst: 'Capacity of the committed token bucket, allowing a burst above its sustained rate.',
    pir: 'Token refill rate for peak traffic; must be at least CIR.',
    pburst: 'Capacity of the peak token bucket, limiting the peak traffic burst.' };
  const reportedRate = { packets_per_second: 'packets/s', kilobits_per_second: 'kilobits/s' }[resource?.rate_unit];
  const unit = rate ? reportedRate || `${quantity}/s` : resource?.burst_unit || quantity;
  return { title, unit, help: `${names[key]} · ${unit}`,
    description: `${names[key]} (${title}). ${explanation[key]} Measured in ${rate ? quantity + ' per second' : quantity}${quantity === 'units' ? '; the meter unit is unspecified' : ', as reported by the switch'}.` };
}
