import { useState } from 'react';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';
import styles from './MobilePanel.module.css';
import { QrCode } from './QrCode';
import { resolveMobileUrl } from './mobileUrl';

export function MobilePanel({ onClose }: { onClose: () => void }) {
  const target = resolveMobileUrl();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(target.url);
    setCopied(true);
  };

  return (
    <PanelShell title="QR" onClose={onClose}>
      {target.kind === 'loopback' ? (
        <p className={panel.note}>
          This page was opened on a loopback address, which no other device can reach. Start the
          dev server so it binds to the network, then reload from that address.
        </p>
      ) : (
        <>
          <div className={styles.plate}>
            <QrCode className={styles.code} value={target.url} label={`QR code for ${target.url}`} />
          </div>

          <p className={styles.address}>{target.url}</p>

          <div className={panel.actions}>
            <button type="button" className="ghost" onClick={copy}>
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>

          <p className={panel.note}>
            Scan from a device on the same network. The certificate is self-signed, so the browser
            warns once before it lets you through. If it won't load, this Mac may be refusing the
            connection under Settings &rarr; Privacy &amp; Security &rarr; Local Network.
          </p>
        </>
      )}
    </PanelShell>
  );
}
