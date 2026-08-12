import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { publish } from '../../api/publish';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { QosSelect } from '../../components/QosSelect';
import { encodePayload, formatJson, type PayloadMode } from '../../lib/payload';
import styles from '../../styles/panel.module.css';
import { useComposeStore } from '../../stores/composeStore';
import { logFault, useLogStore } from '../../stores/logStore';
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
    onSuccess: () => {
      const stamps = [`QoS ${qos}`];
      if (retain) stamps.push('RETAINED');
      if (mode === 'hex') stamps.push('BIN');
      // qos and retain ride along with the stamps: the row loads itself back into this form,
      // and it has to go out the second time exactly as it went out the first. The mode is
      // there for the same reason — hex reloaded as text would send different bytes.
      useLogStore.getState().push({
        kind: 'sent',
        verb: 'Published',
        topic,
        body: payload,
        stamps,
        qos,
        retain,
        mode: mode === 'hex' ? 'hex' : 'text',
      });
    },
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
          <textarea id="payload" value={payload} onChange={(e) => setPayload(e.target.value)} />
        </Field>
      </div>

      {/* The count is the answer to "what actually goes out": in UTF-8 it is not the number of
          characters typed, and in hex it is not the number of digits either. */}
      {encoded.ok ? (
        <p className={styles.note}>{encoded.size} bytes</p>
      ) : (
        <p className={styles.fault}>{encoded.error}</p>
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
