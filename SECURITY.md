# Security

## Reporting something

Use GitHub's [private advisory
form](https://github.com/ibrahimilkhan/mqtt-forge/security/advisories/new) rather than an issue,
which is public from the moment it is filed. It is a single-maintainer project, so expect a reply
when there is one rather than within a stated window.

Supported: the [latest release](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest).
Fixes go into the next one; older versions are not patched.

## What this app is

A test tool with no authentication of its own, which binds `0.0.0.0` on purpose — that is what
lets the QR panel open it on a phone. Anyone who can reach the port can drive it: publish to your
broker, read the traffic, and see the broker host and username. Treat "on my network" as "reachable
by everyone on my network".

To keep it to one machine, publish the port on the loopback address — `-p 127.0.0.1:5169:5169` —
and accept that the QR panel stops working, since there is then no address for a phone to open.

That recipe is only worth anything because the app answers to addresses rather than to names.
`localhost`, any IP literal, and Bonjour names ending `.local` are served; a request naming
anything else is refused before it reaches a controller. Without that, a page served from
`http://evil.example:5169` and then re-resolved to `127.0.0.1` would be same-origin as far as the
browser is concerned — no CORS check to fail — and would reach a server bound to loopback alone
from anyone on the internet who could get that page in front of you. Setting `AllowedHosts` names
the hosts yourself and hands the question to ASP.NET's own host filtering, which is the escape
hatch if you are running behind a reverse proxy.

The broker password is written to the settings file in plain text, unencrypted. The API never
returns it — `GET /api/connection/settings` reports only whether one is set — so this is about
the file on disk, not the endpoint. [README.md](README.md#keeping-your-settings) says where that
file lives.

## Pages on other sites

Any page you have open can send requests to an address your browser can reach, and this app's
are among them: `127.0.0.1`, the LAN address the desktop window loads, the port a container
publishes. The browser keeps the answers from that page, since the app lets no other origin read
one. That is not enough on its own: a form on another site can POST here without asking first,
and a WebSocket is not covered by CORS at all.

So the app refuses, with a 403, a request that a browser says came from a page on another origin
if it would change something — every POST, PUT, PATCH and DELETE — and every request to `/hubs`,
the live channel that carries your broker's traffic to the console, whatever its method. A request
is the app's own when the browser says so in `Sec-Fetch-Site: same-origin`. Where the browser sends
no `Sec-Fetch-Site`, its `Origin` decides, and has to be the scheme, host and port the request was
sent to. That is more often than it sounds: Chromium-based browsers send no `Sec-Fetch-Site` on the
live channel's WebSocket, and no browser sends one to a plain-http address other than loopback — the
desktop window's LAN address, the phone's QR address, a container reached by its IP or a `.local`
name. A development run lets in any page on port 5173 as well, over http or https and whatever its
host, because that is the Vite dev server however it was reached — `https://localhost:5173`, a
phone's `http://<name>.local:5173` — and a page on another site that happens to use that port with
it; a shipped package trusts no other origin at all.

A request with neither header is served as before. That is curl, a script, anything that is not a
browser — anyone who can reach the port, as the section above says. What this closes is the way in
through a page you were shown, not the port itself.

Behind a reverse proxy that ends TLS, the page is https and the app sees http. A current browser's
changes still pass on its `Sec-Fetch-Site: same-origin`, whatever the proxy does to `Host`, but the
live channel's WebSocket is judged by `Origin` against the scheme, host and port the app itself
sees. So the proxy has to keep `Host`, and the app has to be told the scheme
(`ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`). Otherwise the WebSocket is refused, the console falls
back to a stream that some proxies hold back, and the live feed stalls; the app says so in its log,
once for each such page, when a refusal differs from its own address only in the scheme.

The app also says who may show the console in a frame. Every answer carries
`Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`; without them a
page on another site could frame the console and lay a decoy over Disconnect, Inject, Delete flow or
Clear history, and your click would land on the console itself, whose requests are its own. To show
the console inside a page of your own — a Home Assistant panel, say — name that page's origin in
`MqttForge:FrameAncestors`, several with a space or a comma between them:

```
docker run -d -p 5169:5169 -e MqttForge__FrameAncestors=https://homeassistant.local:8123 ghcr.io/ibrahimilkhan/mqtt-forge
```

A current browser goes by that list and lets the page frame the console; one too old for
`frame-ancestors` keeps the console to itself. A value that is not a page — `*`, a scheme on its own,
a wildcard over a whole top-level domain such as `*.com`, anything with a `;` in it — stops the app
from starting rather than letting every site in, and so does a line break at the end of the value,
which a YAML file or a ConfigMap can add without your seeing it; the error names the setting. The
desktop window shows the console as its own page, not in a frame, and is not affected.

## Alerts that leave the machine

A rule can carry a webhook, and webhooks are **on by default**. A rule that has one makes this
app POST to whatever address the rule names, with whatever headers the rule carries, whenever the
rule fires. Anyone who can reach the port can write such a rule, because the app has no
authentication of its own — so on a shared network the section above applies here too, and it
applies harder: a rule is a standing instruction that keeps running after the person who wrote it
has gone.

Local and private addresses are deliberately reachable. `http://127.0.0.1:1880`,
`http://192.168.1.20:8123` and a name on your own LAN all work, and that is the point — the
things people alert into are Node-RED, Home Assistant and a script on the same box. There is no
allow-list and no blocking of private ranges, so treat "this app can reach it" as "a rule can
reach it".

Webhook headers are written to `alert-rules.json` in plain text, unencrypted, the same way the
broker password is written to the settings file. The API never sends them back — `GET
/api/alert-rules` returns header **names** and no values, the way the connection endpoint returns
only whether a password is set — so this is about the file on disk, not the endpoint. Put a
bearer token in a header and it is a bearer token sitting in a JSON file.

To turn all of it off, set `MqttForge:AllowWebhooks` to `false`:

```
docker run -d -p 5169:5169 -e MqttForge__AllowWebhooks=false ghcr.io/ibrahimilkhan/mqtt-forge
```

With that set, a rule's webhook action is never delivered and no HTTP request leaves the process
for one. Everything else about alerting carries on, including the action that publishes the alert
back onto your own broker — that one goes nowhere the broker connection was not already going.

## Flows

Flows (an experimental page) are drawn from nodes and run on the server, whether or not a console
is open. A deployed flow is a standing instruction in the same way an alert rule is: anyone who can
reach the port can deploy one, and it keeps running after they have gone — publishing on a timer,
answering messages, raising alarms. Each flow is held to fifty publishes a second, and at most fifty
flows are kept, so together they can publish up to 2,500 messages a second.

A Publish node can write to any topic the broker lets this app write to, and it can set the retain
flag, so what it writes stays on the broker for every client that subscribes later. That includes
the alert prefix: a flow can leave a retained message there that looks like an alarm record. An
Alarm node's own MQTT record has to stay under the prefix, but nothing keeps a Publish node out of
it. If something acts on what is published under the prefix, decide who may write there in the
broker's own access control.

A flow's alarm webhook goes through the same `MqttForge:AllowWebhooks` switch as a rule's, and its
MQTT alarm stays under the alert prefix, as a rule's does. Flows are kept in `flows.json` beside the
other settings.

None of these is a vulnerability report; they are how the app is built. Something that lets a
person do more than the above is worth telling me about.
