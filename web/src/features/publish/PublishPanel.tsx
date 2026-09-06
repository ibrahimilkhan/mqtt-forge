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

  useEffect(() => {
    if (!draft) return;

    setTopic(draft.topic);
    // A branch node carries no payload of its own; leave whatever is in the box alone. The same
    // guard, and the same reason, for how it was sent: a message hands over its own QoS and retain
    // flag, and a place hands over nothing — because a placeholder written in here is the reader's
    // ticked QoS 2 going quietly back to nought on the way past.
    if (draft.payload !== undefined) setPayload(draft.payload);
    if (draft.mode) setMode(draft.mode);
    if (draft.qos !== undefined) setQos(draft.qos);
    if (draft.retain !== undefined) setRetain(draft.retain);
  }, [draft, setQos, setRetain]);

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
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            aria-invalid={!encoded.ok}
            aria-describedby={encoded.ok ? undefined : 'payload-message'}
          />
        </Field>
      </div>

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
