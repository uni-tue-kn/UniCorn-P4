export const MAX_SAMPLES = 60;

export function totals(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  return entries.reduce((sum, entry) => {
    for (const key of ['packets', 'bytes']) {
      const value = BigInt(entry[key] ?? 0);
      if (value < 0n) throw new Error('The target returned a negative counter.');
      sum[key] += value;
    }
    return sum;
  }, { packets: 0n, bytes: 0n });
}

export function appendSample(samples, counts, time, status = 'sample') {
  const previous = samples.at(-1);
  const sample = { time, counts, status: !counts && status === 'sample' ? 'missing' : status, pps: null, bps: null };
  if (counts && previous?.counts) {
    const elapsed = BigInt(Math.round((time - previous.time) * 1000));
    const packets = counts.packets - previous.counts.packets;
    const bytes = counts.bytes - previous.counts.bytes;
    if (packets < 0n || bytes < 0n) sample.status = 'reset';
    else if (elapsed > 0n) {
      // Rates are fixed-point thousandths. Subtract integers before dividing;
      // never convert raw counters or large deltas to floating point.
      sample.pps = packets * 1_000_000_000n / elapsed;
      sample.bps = bytes * 8_000_000_000n / elapsed;
    }
  } else if (counts) sample.status = 'baseline';
  return [...samples, sample].slice(-MAX_SAMPLES);
}

export function formatRate(value) {
  if (value == null) return '—';
  const fraction = (value % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${value / 1000n}${fraction ? `.${fraction}` : ''}`;
}
