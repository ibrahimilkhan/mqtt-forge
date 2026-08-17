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
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const { isOnline } = useConnectionState();

  // Clicking a topic in the tree, or a message in the wire log, loads it here to be sent back.
  const draft = useComposeStore((state) => state.draft);

  useEffect(() => {
    if (!draft) return;

    setTopic(draft.topic);
    setQos(draft.qos);
    setRetain(draft.retain);
    // A branch node carries no payload of its own; leave whatever is in the box alone.
    if (draft.payload !== undefined) setPayload(draft.payload);
    if (draft.mode) setMode(draft.mode);
  }, [draft]);

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
    // Nothing is logged on success. The log is the record of what came down from the broker, and
    // a row written from this side would say a message landed somewhere on the strength of the
    // request having been accepted. Where the client is subscribed to what it just sent, the
    // broker's own copy arrives and is logged then — as traffic, which is what it is.
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
