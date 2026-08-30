import { useState } from 'react';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';
import styles from './MobilePanel.module.css';
import { QrCode } from './QrCode';
import { copyText } from '../../lib/copyText';
import { resolveMobileUrl } from './mobileUrl';

export function MobilePanel({ onClose }: { onClose: () => void }) {
  const target = resolveMobileUrl();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Says 'Copied' only when something was: over plain http on a LAN address there is no
  // clipboard API, and a button that claims success either way is worse than one that admits it.
  const copy = async () => setState((await copyText(target.url)) ? 'copied' : 'failed');

  const label = { idle: 'Copy address', copied: 'Copied', failed: 'Copy failed' }[state];

  return (
    <PanelShell title="QR" onClose={onClose}>
      {target.kind === 'loopback' ? (
        <p className={panel.note}>
          This page was opened on a loopback address, which no other device can reach. Open it at
          this machine's own address on the network instead — the app is already listening there
          — and the code appears.
        </p>
      ) : (
        <>
          <div className={styles.plate}>
            <QrCode className={styles.code} value={target.url} label={`QR code for ${target.url}`} />
          </div>

          <p className={styles.address}>{target.url}</p>

          <div className={panel.actions}>
            <button type="button" className="ghost" onClick={copy}>
              {label}
            </button>
          </div>
        </>
      )}
    </PanelShell>
  );
}
