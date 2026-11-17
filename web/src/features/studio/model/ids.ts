/**
 * The studio's one id generator — DesignBox had six, each its own shape of random.
 *
 * getRandomValues rather than randomUUID: the console is opened over plain http on the LAN (the QR
 * panel's whole point), which is not a secure context, and randomUUID is not there. Sixteen hex
 * characters also pass the server's scene-id rule as they are.
 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
