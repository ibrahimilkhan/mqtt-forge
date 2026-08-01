// The single place that knows which choices exist and what CSS each one means.
// The two bundled families are the ones self-hosted under public/fonts; the system
// entries download nothing, which is why the tool still works on an air-gapped network.
export const SANS = {
  inter: { label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
  system: {
    label: 'System sans',
    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
} as const;

export const MONO = {
  jetbrains: { label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
  system: {
    label: 'System mono',
    stack: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
  },
} as const;

export type SansId = keyof typeof SANS;
export type MonoId = keyof typeof MONO;

export const SIZE = { min: 12, max: 20, step: 1, default: 15 } as const;

export const DEFAULTS = { sans: 'inter', mono: 'jetbrains', size: SIZE.default } as const;
