import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TrafficChart from './TrafficChart';

describe('traffic plots', () => {
  it('only plots rates supported by the declared counter unit', () => {
    render(<TrafficChart samples={[]} unit={1} />);
    expect(screen.queryByRole('img', { name: 'Packet rate over time' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Bit rate over time' })).toBeVisible();
  });
  it('shows exact rates in a hover tooltip and breaks plotted lines at missing samples', () => {
    const samples = [
      { time: 0, pps: 1000n, bps: 8000n, status: 'sample' },
      { time: 1000, pps: null, bps: null, status: 'missing' },
      { time: 2000, pps: 9007199254740993123n, bps: 16000n, status: 'sample' },
    ];
    render(<TrafficChart samples={samples} />);
    const chart = screen.getByRole('img', { name: 'Packet rate over time' });
    expect(chart.querySelectorAll('path')).toHaveLength(2);
    chart.getBoundingClientRect = () => ({ left: 0, width: 600 });
    fireEvent(chart, new MouseEvent('pointermove', { bubbles: true, clientX: 582 }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('9007199254740993.123 packets/s');
    fireEvent(chart, new MouseEvent('pointerleave', { bubbles: true }));
  });
});
