# Security

## Reporting something

Use GitHub's [private advisory
form](https://github.com/ibrahimilkhan/mqtt-forge/security/advisories/new) rather than an issue,
which is public from the moment it is filed. It is a single-maintainer project, so expect a reply
when there is one rather than within a stated window.

Supported: the [latest release](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest).
Fixes go into the next one; older versions are not patched.

## What this app is

A test console with no authentication of its own, which binds `0.0.0.0` on purpose — that is what
lets the QR panel open it on a phone. Anyone who can reach the port can drive it: publish to your
broker, read the traffic, and see the broker host and username. Treat "on my network" as "reachable
by everyone on my network".

To keep it to one machine, publish the port on the loopback address — `-p 127.0.0.1:5169:5169` —
and accept that the QR panel stops working, since there is then no address for a phone to open.

The broker password is written to the settings file in plain text, unencrypted. The API never
returns it — `GET /api/connection/settings` reports only whether one is set — so this is about
the file on disk, not the endpoint. [README.md](README.md#keeping-your-settings) says where that
file lives.

Neither of these is a vulnerability report; they are how the app is built. Something that lets a
person do more than the above is worth telling me about.
