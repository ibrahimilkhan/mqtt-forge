import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { publish } from '../../api/publish';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { QosSelect } from '../../components/QosSelect';
import { encodePayload, formatJson, type PayloadMode } from '../../lib/payload';
import styles from '../../styles/panel.module.css';
import { useComposeStore } from '../../stores/composeStore';
import { logFault } from '../../stores/logStore';
import { useConnectionState } from '../../api/useConnectionState';
import { useGuardedMutate } from '../../lib/useGuardedMutate';

/**
 * How big a loaded body has to be before the box shows it in part.
 *
 * A textarea lays out every character it holds, however few of them its four visible lines can
 * show. Clicking a topic loads that topic's message in here, so the layout of a body the reader
 * has not asked to read is on the click: a megabyte of JSON measured 150 ms of the 180 ms that
 * selecting such a topic took, and the same body cut to four thousand characters measured 0.6 ms.
 * That pause is the console 'loading' — for a message nobody was going to edit by hand.
 *
 * Sixty-four kilobytes is far above any body a reader types or tweaks here, and lays out in about
 * ten milliseconds, which nobody feels.
 */
const SHOW_WHOLE = 64 * 1024;

/** How much of a body over that ceiling the box does show. Four lines can show nothing near it. */
const CLAMP_CHARS = 4_000;

const MODES: ReadonlyArray<{ id: PayloadMode; label: string }> = [
  { id: 'text', label: 'Text' },
  { id: 'json', label: 'JSON' },
  { id: 'hex', label: 'Hex' },
];

export function PublishPanel() {
  const [topic, setTopic] = useState('sensors/temp');
  const [payload, setPayload] = useState('23.5');
  const [mode, setMode] = useState<PayloadMode>('text');
  // How it goes out is held in the store rather than here, for two reasons that turned out to be
  // the same reason: nothing that loads a draft can write over it, and folding this region away
  // — which unmounts the panel — cannot quietly put it back to nought either.
  const qos = useComposeStore((state) => state.qos);
  const retain = useComposeStore((state) => state.retain);
  const setQos = useComposeStore((state) => state.setQos);
  const setRetain = useComposeStore((state) => state.setRetain);
  const { isOnline } = useConnectionState();

  // Clicking a topic in the tree, or a message in the wire log, loads it here to be sent back.
  const draft = useComposeStore((state) => state.draft);

  // Whether the reader has asked to see a body too big to show whole. Held here rather than
  // derived, so that a body the reader opened stays open while they edit it.
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!draft) return;

    setTopic(draft.topic);
    // A branch node carries no payload of its own; leave whatever is in the box alone. The same
    // guard, and the same reason, for how it was sent: a message hands over its own QoS and retain
    // flag, and a place hands over nothing — because a placeholder written in here is the reader's
    // ticked QoS 2 going quietly back to nought on the way past.
    if (draft.payload !== undefined) {
      setPayload(draft.payload);
      // A new body is a new question: one the reader opened does not open the next one.
      setOpened(false);
    }
    if (draft.mode) setMode(draft.mode);
    if (draft.qos !== undefined) setQos(draft.qos);
    if (draft.retain !== undefined) setRetain(draft.retain);
  }, [draft, setQos, setRetain]);

  // A body over the ceiling that the reader has not opened. What is held is still the whole of
  // it — this is what the box shows, not what Publish sends.
  const clamped = !opened && payload.length > SHOW_WHOLE;

  // What would go out if Publish were pressed now — and, when it would not go out, why.
  // Memoised so a large hex body is not re-parsed and re-base64'd on renders unrelated to it.
  const encoded = useMemo(() => encodePayload(mode, payload), [mode, payload]);

  const publishMutation = useMutation({
    mutationFn: () => {
      if (!encoded.ok) throw new Error(encoded.error);

      return publish({
        topic,
        payload: encoded.payload,
        payloadEncoding: encoded.payloadEncoding,
        qos,
        retain,
      });
    },
    /*
     * Still nothing on success, and the reason is stronger than it looks.
     *
     * The log is the record of what came down from the broker, and a row written from this side
     * would claim a message had landed on the strength of a 202. But there is a second reason,
     * found while chasing 'publishing ignores my QoS': the log's non-arrival entries are not
     * drawn at all. They go to `commands`, which has one reader — `faultOn` — and that reader
     * draws faults only, and takes any later 'ok' naming an overlapping topic as evidence that
     * the fault has been put right. So a 'Published' row would be invisible *and* would silence a
     * standing 'Subscribe failed' explanation for that topic.
     *
     * What the reader was actually missing is said where the confusion happens instead: the chips
     * on an arrival answer a question about the *delivery*, and they now say so. See `unsaid` in
     * MessageDetail and `stampMeaning` in the log store.
     */
    onError: (error) => logFault('Publish failed', error, topic),
  });
  const guardedPublish = useGuardedMutate(publishMutation);

  return (
    <PanelShell title="Publish">
      <div className={styles.row}>
        <Field label="Topic" htmlFor="topic">
          <input id="topic" type="text" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </Field>
      </div>

      <div className={styles.checks}>
        {MODES.map((option) => (
          <label key={option.id}>
            <input
              type="radio"
              name="payload-mode"
              value={option.id}
              checked={mode === option.id}
              onChange={() => setMode(option.id)}
            />
            {` ${option.label}`}
          </label>
        ))}
      </div>

      <div className={styles.row}>
        <Field label="Payload" htmlFor="payload">
          <textarea
            id="payload"
            value={clamped ? payload.slice(0, CLAMP_CHARS) : payload}
            onChange={(e) => setPayload(e.target.value)}
            // Shown in part, so it cannot be typed in: an edit would otherwise write the shown
            // part back over the whole body and publish a message the reader never had.
            readOnly={clamped}
            aria-invalid={!encoded.ok}
            aria-describedby={clamped ? 'payload-held' : encoded.ok ? undefined : 'payload-message'}
          />
        </Field>
      </div>

      {clamped && (
        <p id="payload-held" className={styles.note}>
          {`Holding all ${payload.length.toLocaleString('en-GB')} characters; showing the ` +
            `first ${CLAMP_CHARS.toLocaleString('en-GB')}. Publish sends the whole body. `}
          <button type="button" className={styles.reveal} onClick={() => setOpened(true)}>
            Show all
          </button>
        </p>
      )}

      {/* The count is the answer to "what actually goes out": in UTF-8 it is not the number of
          characters typed, and in hex it is not the number of digits either. */}
      {encoded.ok ? (
        <p className={styles.note}>{encoded.size} bytes</p>
      ) : (
        <p id="payload-message" className={styles.fault}>{encoded.error}</p>
      )}

      <div className={styles.checks}>
        <QosSelect name="qos" value={qos} onChange={setQos} />
        <label>
          <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
          {' Retain'}
        </label>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => guardedPublish()}
          disabled={!isOnline || publishMutation.isPending || !encoded.ok}
        >
          Publish
        </button>

        {mode === 'json' && (
          <button
            type="button"
            className="ghost"
            onClick={() => setPayload(formatJson(payload))}
            disabled={!encoded.ok}
          >
            Format
          </button>
        )}
      </div>
    </PanelShell>
  );
}
