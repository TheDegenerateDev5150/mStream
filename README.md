# mStream Music

mStream is a personal music streaming server.  You can use mStream to stream your music from your home computer to any device, anywhere.

Main|Shared|Admin
---|---|---
![main](/docs/designs/mstreamv5.png?raw=true)|![shared](/docs/designs/shared.png?raw=true)|![admin](/docs/designs/admin.png?raw=true)

## Demo & Other Links

#### [Check Out The Demo!](https://demo.mstream.io/)

#### [Discord Channel](https://discord.gg/AM896Rr)

#### [Website](https://mstream.io)

### Server Features
* Cross Platform. Works on Windows, OSX, Linux, & FreeBSD and ARM CPUs
* Light on memory and CPU
* Tested on multi-terabyte libraries
* Metadata parser written in Rust for fast indexing - JS fallback included for maximum compatibility
* Multi-user accounts with per-library access control
* DLNA / UPnP server for casting to TVs and stereos
* [Subsonic / OpenSubsonic API](https://opensubsonic.netlify.app/) — works with DSub, play:Sub, Symfonium, Feishin, Supersonic, and other Subsonic clients
* On-the-fly transcoding via ffmpeg (opus, mp3, aac)
* Server-side audio playback for headless boxes (Rust audio engine + CLI fallback)

### WebApp Features
* Gapless Playback
* Milkdrop Visualizer ([Butterchurn](https://github.com/jberg/butterchurn))
* Playlist Sharing via signed links
* Upload, create, and rename files through the file explorer
* Synced + plain lyrics (embedded, sidecar `.lrc`, or [LRCLib](https://lrclib.net/) — opt-in)
* Waveform previews rendered at scan time
* Album art auto-fetch from MusicBrainz, iTunes, and Deezer
* Admin UI for server configuration

## Installing mStream

* [Docker Instructions](https://github.com/linuxserver/docker-mstream)
* [Binaries for Win/OSX/Linux](https://mstream.io/server)
* [Install From Source](docs/install.md)
* [AWS Cloud using Terraform](https://gitlab.com/SiliconTao-Systems/nova)

## Mobile Apps

[<img src="/webapp/assets/img/app-store-logo.png" alt="mStream iOS App" width="200" />](https://apps.apple.com/us/app/mstream-player/id1605378892)

[<img src="/webapp/assets/img/play-store-logo.png" alt="mStream Android App" width="200" />](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US)

[Made by Niera Tech](https://mplayer.nieratech.com/)

## Quick Install from CLI

Deploying an mStream server is simple.

```shell
# Install From Git
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

# Install dependencies and run
npm run-script wizard
```

## Technical Details

* **Dependencies:** NodeJS v22.5 or greater
* **Database:** SQLite (via `node:sqlite`) — no external DB server required
* **Scanner:** Pre-built Rust binary (Linux x64/arm/arm64 + musl, macOS x64/arm64, Windows x64); falls back to a pure-JS scanner when no binary matches the host
* **Supported File Formats:** flac, mp3, wav, ogg, opus, aac, m4a, m4b
* **APIs:** mStream `/api/v1` (REST, [OpenAPI spec](docs/openapi.yaml)) and Subsonic `/rest` (1.16.1 + OpenSubsonic extensions)

## Credits

mStream is built on top of some great open-source libraries:

* [music-metadata](https://github.com/Borewit/music-metadata) - The metadata parser used by the JS scanner fallback
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Audio tag reader powering the Rust scanner
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Pure-Rust audio decoder used to render waveform previews during a scan
* [Butterchurn](https://github.com/jberg/butterchurn) - A clone of Milkdrop Visualizer written in JavaScript
* [Syncthing](https://syncthing.net/) - Powers federation between mStream servers
* [LRCLib](https://lrclib.net/) - Optional source for synced lyrics

And thanks to the [LinuxServer.io](https://www.linuxserver.io/) group for maintaining the Docker image!
