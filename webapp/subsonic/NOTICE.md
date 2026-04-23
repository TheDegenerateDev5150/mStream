# webapp/subsonic — Airsonic Refix

This directory contains a pre-built copy of **Airsonic Refix**
(<https://github.com/tamland/airsonic-refix>), an Apache/Airsonic-
compatible web client. It is served by mStream when `config.ui ==
'subsonic'`, talking to mStream's own `/rest/*` Subsonic endpoints —
users log in with their mStream username + password (or an API key).

## Source + version

- Upstream: <https://github.com/tamland/airsonic-refix>
- Image extracted from: `tamland/airsonic-refix:latest`
  (<https://hub.docker.com/r/tamland/airsonic-refix>)
- Build type: production static bundle (`/var/www/html/` from the
  Docker image, minus the demo-server `_redirects` rule)

## License

Airsonic Refix is licensed under **AGPL-3.0-or-later**. mStream itself
is GPL-3.0-or-later; AGPL is compatible for aggregation but the
network-interaction clause continues to apply to THIS directory's
contents. Practical consequence for mStream operators who enable the
Subsonic UI:

- You may run the unmodified bundle freely.
- If you *modify* the Refix portion and let users reach it over the
  network, you must offer them the modified Refix source (AGPL §13).
- The rest of mStream stays under GPL-3.0-or-later.

The full AGPL text is in `LICENSE.AGPL` in this directory.

## Updating

To refresh against a newer upstream:

```sh
docker pull tamland/airsonic-refix:latest
docker run -d --name refix-extract tamland/airsonic-refix:latest
mkdir -p webapp/subsonic
rm -rf webapp/subsonic/assets  # clear old chunked bundles
docker cp refix-extract:/var/www/html/. webapp/subsonic/
rm -f webapp/subsonic/_redirects  # points at demo.subsonic.org; not ours
docker rm -f refix-extract
```

The `env.js` shim ships with `SERVER_URL: ""` so the client points at
its own origin (i.e. mStream). Leave it alone unless you're pointing
the bundled client at a different Subsonic server.
