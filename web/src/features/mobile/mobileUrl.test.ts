import { describe, expect, it } from 'vitest';
import { resolveMobileUrl } from './mobileUrl';

const at = (url: string) => {
  const parsed = new URL(url);
  return { origin: parsed.origin, hostname: parsed.hostname };
};

describe('resolveMobileUrl', () => {
  it('prefers the address the dev server reports over the one in the address bar', () => {
    const target = resolveMobileUrl('https://mq.local:5173/', at('https://localhost:5173/'));

    expect(target).toEqual({ kind: 'reachable', url: 'https://mq.local:5173/' });
  });

  it('falls back to the origin when there is no hint, as in a production build', () => {
    const target = resolveMobileUrl(null, at('https://192.168.1.100:5169/'));

    expect(target).toEqual({ kind: 'reachable', url: 'https://192.168.1.100:5169/' });
  });

  it('reports a loopback origin rather than encoding an address no phone can open', () => {
    expect(resolveMobileUrl(null, at('http://localhost:5169/')).kind).toBe('loopback');
    expect(resolveMobileUrl(null, at('http://127.0.0.1:5169/')).kind).toBe('loopback');
  });
});
