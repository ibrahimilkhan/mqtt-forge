// Bundled families are self-hosted under public/fonts; system entries need no download,
// which keeps the tool working on an air-gapped network.
export const SANS = {
  inter: {
    label: 'Inter',
    stack: "'Inter', -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
  },
  system: {
    label: 'System sans',
    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
} as const;

export const MONO = {
  jetbrains: {
    label: 'JetBrains Mono',
    stack: "'JetBrains Mono', ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, monospace",
  },
  system: {
    label: 'System mono',
    stack: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
  },
} as const;

export type SansId = keyof typeof SANS;
export type MonoId = keyof typeof MONO;

export const SIZE = { min: 12, max: 20, step: 1, default: 15 } as const;

// Fonts only. What the appearance store holds is these plus the chart's detail, composed there:
// this file is read by a guard test that runs under Node, where an import of anything else in
// the feature would need a file extension it has no business carrying.
export const DEFAULTS = { sans: 'inter', mono: 'jetbrains', size: SIZE.default } as const;
