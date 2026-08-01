# web

The React panel. `npm run dev` starts Vite on port 5173 and proxies `/api` and `/hubs` to the
API on `localhost:5169`, which has to be running separately.

## Testing on a phone

The dev server binds to every interface, so it is reachable from any device on the same
network, either at `https://<machine-name>.local:5173/` or at `https://<your-lan-ip>:5173/`.
The Bonjour name is the better one to type: it is shorter and it survives a DHCP lease
change. Rename the machine under *System Settings → General → Sharing → Local hostname* to
shorten it further, then rerun the certificate script below.

The API stays on localhost — the proxy runs on the development machine, so only Vite needs
to be exposed.

HTTPS is opt-in and requires a certificate, because the browser only grants clipboard,
notification and similar APIs in a secure context:

```bash
npm run cert --prefix web
```

This writes `web/certs/`, which is gitignored — the certificate covers this machine's Bonjour
name and its current LAN address. Rerun it after renaming the machine or joining a network
that hands out a different address, or pass an address explicitly with
`npm run cert --prefix web -- 192.168.1.42`. Without the certificate the dev server falls
back to plain HTTP and everything else behaves the same.

The certificate is self-signed, so the phone shows a warning on first visit. On iOS that is
*Show Details* → *visit this website*; on Android, *Advanced* → *Proceed*.
