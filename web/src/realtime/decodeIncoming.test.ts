import { describe, expect, it } from 'vitest';
import { decodeIncoming } from './decodeIncoming';

const MESSAGE = {
  topic: 'sensors/temp',
  payload: '23.5',
  qos: 0,
  retain: false,
  receivedAt: '2026-08-13T10:00:00Z',
};

describe('decodeIncoming', () => {
  it('leaves text alone', () => {
    expect(decodeIncoming({ ...MESSAGE, payloadEncoding: 'text' })).toMatchObject({
      payload: '23.5',
      mode: 'text',
      size: 4,
    });
  });

  it('treats a message with no encoding as text', () => {
    expect(decodeIncoming(MESSAGE)).toMatchObject({ payload: '23.5', mode: 'text' });
  });

  it('counts text in bytes, not characters', () => {
    expect(decodeIncoming({ ...MESSAGE, payload: 'ö' })).toMatchObject({ size: 2 });
  });

  it('renders base64 as hex', () => {
    expect(
      decodeIncoming({ ...MESSAGE, payload: 'AaT/', payloadEncoding: 'base64' }),
    ).toMatchObject({ payload: '01 A4 FF', mode: 'hex', size: 3 });
  });

  it('keeps topic, qos, retain and the timestamp', () => {
    const decoded = decodeIncoming({ ...MESSAGE, qos: 2, retain: true });

    expect(decoded).toMatchObject({
      topic: 'sensors/temp',
      qos: 2,
      retain: true,
      receivedAt: '2026-08-13T10:00:00Z',
    });
  });
});
