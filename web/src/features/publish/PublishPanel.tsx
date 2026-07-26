import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { publish } from '../../api/publish';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { QosSelect } from '../../components/QosSelect';
import styles from '../../styles/panel.module.css';
import { useLogStore } from '../../stores/logStore';
import { useConnectionState } from '../../api/useConnectionState';
import { describeError } from '../../lib/problemDetails';

export function PublishPanel({ onClose }: { onClose: () => void }) {
  const [topic, setTopic] = useState('sensors/temp');
  const [payload, setPayload] = useState('23.5');
  const [qos, setQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const { isOnline } = useConnectionState();

  const publishMutation = useMutation({
    mutationFn: () => publish({ topic, payload, qos, retain }),
    onSuccess: () => {
      const stamps = [`QoS ${qos}`];
      if (retain) stamps.push('RETAINED');
      useLogStore.getState().push({ kind: 'sent', verb: 'Published', topic, body: payload, stamps });
    },
    onError: (error) =>
      useLogStore.getState().push({ kind: 'fault', verb: 'Publish failed', topic, body: describeError(error) }),
  });

  return (
    <PanelShell title="Publish" onClose={onClose}>
      <div className={styles.row}>
        <Field label="Topic" htmlFor="topic">
          <input id="topic" type="text" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </Field>
      </div>

      <div className={styles.row}>
        <Field label="Payload" htmlFor="payload">
          <textarea id="payload" value={payload} onChange={(e) => setPayload(e.target.value)} />
        </Field>
      </div>

      <div className={styles.checks}>
        <QosSelect name="qos" value={qos} onChange={setQos} />
        <label>
          <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
          {' Retain'}
        </label>
      </div>

      <div className={styles.actions}>
        <button type="button" onClick={() => publishMutation.mutate()} disabled={!isOnline}>
          Publish
        </button>
      </div>
    </PanelShell>
  );
}
