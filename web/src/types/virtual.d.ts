declare module 'virtual:network-url' {
  /** Address other devices can reach this dev server at, or null outside the dev server. */
  export const networkUrl: string | null;
}

/**
 * A stylesheet read as text.
 *
 * Vite's own `?raw` suffix. Used by the palette's contrast test, which measures the tokens that
 * actually ship rather than a copy of them restated in the test.
 */
declare module '*.css?raw' {
  const contents: string;
  export default contents;
}
