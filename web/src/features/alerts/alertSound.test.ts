import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { fakeAudio } from '../../test/fakeAudio';
import { useAppearanceStore } from '../../stores/appearanceStore';
import type { AlertDto, AlertSeverity } from '../../types/api';
import {
  armSound,
  forgetSound,
  NOT_READY,
  soundAlert,
  soundFor,
  TONES,
  turnSoundOff,
  turnSoundOn,
  useSoundStore,
} from './alertSound';

/**
 * An alert as the hub sends one, with only the parts the player reads made interesting.
 *
 * `actions` is `string[]` and not a union of channel names: a delivery that failed is written
 * 'webhook: 404', so the wire form is free text. Nothing here has to care — no failure string is
 * ever the word 'sound'.
 */
function alertWith(severity: AlertSeverity, actions: string[]): AlertDto {
  return {
    id: `a-${severity}`,
    ruleId: 'r-1',
    ruleName: 'Kiln too hot',
    topic: 'plant/kiln-2/temp',
    severity,
    firedAt: '2026-09-01T09:12:00Z',
    lastSeenAt: '2026-09-01T09:12:00Z',
    resolvedAt: null,
    resolvedBy: null,
    mutedUntil: null,
    count: 1,
    reason: '94.2 over 90',
    value: 94.2,
    sample: '94.2',
    actions,
  };
}

beforeEach(() => {
  // The module holds one context for the life of a page, and a test file is many pages.
  forgetSound();
  useAppearanceStore.getState().reset();
  localStorage.clear();
});

afterEach(() => {
  forgetSound();
  vi.unstubAllGlobals();
});

describe('the tone', () => {
  it('says nothing at all while the preference is off', async () => {
    const audio = fakeAudio();
    await armSound();

    expect(soundAlert('critical')).toBe(false);
    expect(audio.tones).toHaveLength(0);
  });

  it('plays when the preference is on and the context is armed', async () => {
    const audio = fakeAudio();
    await turnSoundOn();

    expect(soundAlert('warn')).toBe(true);
    expect(audio.tones.map((tone) => tone.hz)).toEqual([TONES.warn.hz, TONES.warn.hz]);
  });

  // Colour is not the only thing a reader cannot tell apart: three alarms that sound alike are
  // one alarm as far as the room is concerned.
  it('gives each severity a pitch and a count of its own', async () => {
    const audio = fakeAudio();
    await turnSoundOn();

    soundAlert('info');
    soundAlert('critical');

    expect(audio.tones.filter((tone) => tone.hz === TONES.info.hz)).toHaveLength(TONES.info.beeps);
    expect(audio.tones.filter((tone) => tone.hz === TONES.critical.hz)).toHaveLength(
      TONES.critical.beeps,
    );
    expect(TONES.info.hz).not.toBe(TONES.critical.hz);
  });

  // A wide filter raises a batch in one message. Ten overlapping oscillators is not an alarm.
  it('sounds once for a batch, at the worst severity in it', async () => {
    const audio = fakeAudio();
    await turnSoundOn();

    soundFor([
      alertWith('info', ['screen', 'sound']),
      alertWith('critical', ['sound']),
      alertWith('warn', ['sound']),
    ]);

    expect(audio.tones.map((tone) => tone.hz)).toEqual(
      Array.from({ length: TONES.critical.beeps }, () => TONES.critical.hz),
    );
  });

  // screen and sound are separate actions on the rule. A silent notice is a valid request, and a
  // failed webhook writes itself into this same array as 'webhook: 404' without ever asking for a
  // tone — which is the other half of why the match here is exact and not a prefix.
  it('leaves an alert that never asked for a tone silent', async () => {
    const audio = fakeAudio();
    await turnSoundOn();

    soundFor([alertWith('critical', ['screen', 'webhook: 404'])]);

    expect(audio.tones).toHaveLength(0);
  });
});

describe('the permission the browser holds back', () => {
  it('says it is not ready rather than failing quietly', () => {
    const audio = fakeAudio({ suspended: true, refuseResume: true });
    useAppearanceStore.getState().setAlertSound(true);

    expect(() => soundAlert('critical')).not.toThrow();
    expect(audio.tones).toHaveLength(0);
    expect(useSoundStore.getState()).toEqual({ armed: false, waiting: true });
    expect(NOT_READY).toContain('not ready');
  });

  it('arms itself on the next thing the reader does, and sounds after that', async () => {
    const audio = fakeAudio({ suspended: true });
    useAppearanceStore.getState().setAlertSound(true);
    soundAlert('critical');

    window.dispatchEvent(new Event('pointerdown'));

    await waitFor(() => expect(useSoundStore.getState()).toEqual({ armed: true, waiting: false }));
    expect(soundAlert('info')).toBe(true);
    expect(audio.tones).toHaveLength(TONES.info.beeps);
  });

  // The button is the gesture. Setting the preference and asking for permission in two separate
  // acts is how a setting ends up on with nothing behind it.
  it('turns on the preference and takes the permission in the one press', async () => {
    fakeAudio({ suspended: true });

    await turnSoundOn();

    expect(useAppearanceStore.getState().alertSound).toBe(true);
    expect(useSoundStore.getState().armed).toBe(true);

    turnSoundOff();

    expect(useAppearanceStore.getState().alertSound).toBe(false);
    expect(useSoundStore.getState().waiting).toBe(false);
  });

  // No WebAudio at all is not the same as permission withheld: there is nothing to click, so
  // there is nothing to promise, and 'click to turn it on' would be an instruction to nowhere.
  it('promises nothing in a browser with no WebAudio', async () => {
    vi.stubGlobal('AudioContext', undefined);
    useAppearanceStore.getState().setAlertSound(true);

    expect(await armSound()).toBe(false);
    expect(() => soundAlert('critical')).not.toThrow();
    expect(useSoundStore.getState()).toEqual({ armed: false, waiting: false });
  });
});
