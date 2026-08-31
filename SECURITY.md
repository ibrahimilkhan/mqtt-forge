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

Neither of these is a vulnerability report; they are how the app is built. Something that lets a
person do more than the above is worth telling me about.
