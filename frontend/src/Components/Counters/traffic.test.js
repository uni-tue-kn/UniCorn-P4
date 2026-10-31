import { describe, expect, it } from 'vitest';
import { appendSample, formatRate, MAX_SAMPLES, totals } from './traffic';

describe('lossless traffic rates', () => {
  it('subtracts counters beyond floating-point precision before calculating rates', () => {
    let samples = appendSample([], { packets: 900719925474099300n, bytes: 900719925474099300n }, 1000);
    samples = appendSample(samples, { packets: 900719925474099303n, bytes: 900719925474099500n }, 2500);
    expect(formatRate(samples[1].pps)).toBe('2');
    expect(formatRate(samples[1].bps)).toBe('1066.666');
  });
  it('aggregates values with integer precision', () => {
    expect(totals([{ packets: '9007199254740993', bytes: '5' }, { packets: '2', bytes: '7' }])).toEqual({ packets: 9007199254740995n, bytes: 12n });
    expect(totals([])).toBeNull();
  });
  it('creates gaps for resets, missing samples and pauses without negative spikes', () => {
    let samples = appendSample([], { packets: 20n, bytes: 100n }, 0);
    samples = appendSample(samples, { packets: 1n, bytes: 10n }, 1000);
    expect(samples.at(-1)).toMatchObject({ pps: null, bps: null, status: 'reset' });
    samples = appendSample(samples, null, 2000, 'missing');
    samples = appendSample(samples, { packets: 10n, bytes: 100n }, 3000);
    expect(samples.at(-1)).toMatchObject({ pps: null, status: 'baseline' });
    samples = appendSample(samples, null, 3500, 'paused');
    samples = appendSample(samples, { packets: 15n, bytes: 500n }, 4500);
    expect(samples.at(-1).pps).toBeNull();
  });
  it('bounds the history and rejects negative target values', () => {
    let samples = [];
    for (let index = 0; index < 100; index++) samples = appendSample(samples, { packets: BigInt(index), bytes: BigInt(index) }, index * 1000);
    expect(samples).toHaveLength(MAX_SAMPLES);
    expect(samples[0].time).toBe(40_000);
    expect(() => totals([{ packets: '-1', bytes: '0' }])).toThrow('negative counter');
  });
});
