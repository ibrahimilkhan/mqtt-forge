import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';
import { QrCode } from './QrCode';

const MARGIN = 4;

/** What the encoder says the code should be, independent of how the component draws it. */
function reference(value: string) {
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();

  const count = code.getModuleCount();
  let dark = 0;
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) if (code.isDark(row, col)) dark += 1;
  }
  return { count, dark };
}

describe('QrCode', () => {
  it('draws one square per dark module, inside a quiet zone', () => {
    const value = 'https://mq.local:5173/';
    const { count, dark } = reference(value);

    render(<QrCode value={value} label="code" />);
    const svg = screen.getByRole('img', { name: 'code' });
    const path = svg.querySelector('path')?.getAttribute('d') ?? '';

    expect(path.match(/M/g)).toHaveLength(dark);
    expect(svg).toHaveAttribute('viewBox', `0 0 ${count + MARGIN * 2} ${count + MARGIN * 2}`);
  });

  it('grows the symbol rather than truncating when the address is longer', () => {
    const short = reference('https://a.local:5173/').count;
    const long = reference(`https://a.local:5173/${'x'.repeat(200)}`).count;

    expect(long).toBeGreaterThan(short);
  });

  it('keeps the code dark-on-light so it scans under either appearance', () => {
    render(<QrCode value="https://mq.local:5173/" label="code" />);
    const svg = screen.getByRole('img', { name: 'code' });

    expect(svg.querySelector('rect')).toHaveAttribute('fill', '#fff');
    expect(svg.querySelector('path')).toHaveAttribute('fill', '#000');
  });
});
