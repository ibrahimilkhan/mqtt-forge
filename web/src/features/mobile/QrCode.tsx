import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Quiet zone the spec asks for, in modules. Scanners get unreliable without it. */
const MARGIN = 4;

export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { path, size } = useMemo(() => build(value), [value]);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} role="img" aria-label={label}>
      {/* Deliberately not themed. A QR code has to be dark-on-light to scan reliably, so
          the plate stays white and the modules black in both light and dark appearance. */}
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function build(value: string) {
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();

  const count = code.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) path += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
    }
  }

  return { path, size: count + MARGIN * 2 };
}
