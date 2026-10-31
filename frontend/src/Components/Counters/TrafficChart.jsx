import React, { useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { formatRate, MAX_SAMPLES } from './traffic';

function axisRate(value) {
  const suffixes = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z'];
  let unit = 0;
  while (value >= 1_000_000n && unit < suffixes.length - 1) { value /= 1000n; unit++; }
  return `${formatRate(value)}${suffixes[unit]}`;
}

function RatePlot({ samples, metric, title, unit, color }) {
  const [hover, setHover] = useState(null);
  const width = 600, height = 190, left = 92, right = 18, top = 20, bottom = 36;
  const maximum = samples.reduce((max, sample) => sample[metric] != null && sample[metric] > max ? sample[metric] : max, 1000n);
  const start = samples[0]?.time || 0;
  const duration = Math.max(1000, (samples.at(-1)?.time || 0) - start);
  const x = sample => left + (sample.time - start) / duration * (width - left - right);
  const y = value => height - bottom - Number(value * 100_000n / maximum) / 100_000 * (height - top - bottom);
  const paths = [];
  let path = '';
  for (const sample of samples) {
    if (sample[metric] == null) { if (path) paths.push(path); path = ''; }
    else path += `${path ? 'L' : 'M'}${x(sample)},${y(sample[metric])} `;
  }
  if (path) paths.push(path);
  const active = hover == null ? null : samples[hover];
  return <Box sx={{ minWidth: 0, flex: 1 }}>
    <Typography variant="subtitle2">{title}</Typography>
    <Box sx={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} over time`} style={{ display: 'block', width: '100%', minHeight: 150 }} onPointerLeave={() => setHover(null)} onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - rect.left) / rect.width * width;
        let nearest = null, distance = Infinity;
        samples.forEach((sample, index) => { if (Math.abs(x(sample) - position) < distance) { nearest = index; distance = Math.abs(x(sample) - position); } });
        setHover(nearest);
      }}>
        {[0n, maximum / 2n, maximum].map((tick, index) => <g key={index}>
          <line x1={left} y1={y(tick)} x2={width - right} y2={y(tick)} stroke="currentColor" opacity="0.12" />
          <text x={left - 8} y={y(tick) + 4} textAnchor="end" fill="currentColor" fontSize="11">{axisRate(tick)}</text>
        </g>)}
        <line x1={left} y1={top} x2={left} y2={height - bottom} stroke="currentColor" opacity="0.4" />
        <text x={left} y={height - 12} fill="currentColor" fontSize="11">0 s</text>
        <text x={width - right} y={height - 12} textAnchor="end" fill="currentColor" fontSize="11">{Math.round(duration / 1000)} s</text>
        <text x={left} y={12} fill="currentColor" fontSize="11">{unit}</text>
        {paths.map((data, index) => <path key={index} d={data} fill="none" stroke={color} strokeWidth="2.5" />)}
        {samples.map((sample, index) => sample[metric] == null ? null : <circle key={index} cx={x(sample)} cy={y(sample[metric])} r="2.5" fill={color}><title>{formatRate(sample[metric])} {unit}</title></circle>)}
        {active && <line x1={x(active)} y1={top} x2={x(active)} y2={height - bottom} stroke="currentColor" opacity="0.4" strokeDasharray="3 3" />}
      </svg>
      {active && <Box role="tooltip" sx={{ position: 'absolute', top: 0, right: 0, bgcolor: 'background.paper', border: 1, borderColor: 'divider', px: 1, borderRadius: 1, maxWidth: '100%', overflowWrap: 'anywhere' }}>{formatRate(active[metric])} {unit} · +{((active.time - start) / 1000).toFixed(1)} s{active[metric] == null ? ` · ${active.status}` : ''}</Box>}
    </Box>
  </Box>;
}

export default function TrafficChart({ samples, unit = 3 }) {
  const latest = samples.at(-1);
  const rates = [unit !== 1 && `${formatRate(latest?.pps)} packets/s`, unit !== 2 && `${formatRate(latest?.bps)} bits/s`].filter(Boolean);
  return <Box sx={{ my: 2 }}>
    <Typography variant="h6">Traffic rates</Typography>
    <Typography variant="body2" color="text.secondary">{rates.join(' · ')}</Typography>
    <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2}>
      {unit !== 1 && <RatePlot samples={samples} metric="pps" title="Packet rate" unit="packets/s" color="#00887c" />}
      {unit !== 2 && <RatePlot samples={samples} metric="bps" title="Bit rate" unit="bits/s" color="#9f8ce8" />}
    </Stack>
    <Typography variant="caption" color="text.secondary">Latest {MAX_SAMPLES} samples. Hover over a point for its rate. Resets, missing reads and paused polling create gaps.</Typography>
    {latest?.status === 'reset' && <Typography variant="body2" color="text.secondary">Counter reset detected; waiting for the next sample.</Typography>}
    {latest?.status === 'baseline' && <Typography variant="body2" color="text.secondary">Collecting the next sample…</Typography>}
  </Box>;
}
