# Jinx

Streams anime into a Discord voice channel as Go Live video, driven by a slash
command and an in-channel control panel.

Two programs, deliberately kept apart:

- **streamer** logs in with a **user** token, joins voice and broadcasts video.
  It has no commands and no interface.
- **controller** is a normal **application bot**. It owns `/stream` and the panel,
  and never touches video.

They talk over HTTP on 127.0.0.1.

> ## Read this first
>
> **A selfbot violates Discord's Terms of Service.** Automating a user account
> can get that account permanently banned. This is not a theoretical risk and
> there is no setting that makes it safe.
>
> **Use a throwaway account you do not care about losing.** Do not use your
> main account, and do not use an account attached to anything you would miss.
>
> The controller half is an ordinary application bot and is fine. Only the
> streamer half, which needs a user token because application bots cannot
> stream video, breaks the rules.

## Contents

- [Install](#install)
- [Configure](#configure)
- [Run](#run)
- [Using it](#using-it)
- [Architecture](#architecture)
- [Why it is built this way](#why-it-is-built-this-way)
- [Testing](#testing)
- [What has not been verified](#what-has-not-been-verified)
- [Troubleshooting](#troubleshooting)

## Install

Debian or Ubuntu, as a user with sudo:

```bash
git clone <your repo> jinx && cd jinx
npm run setup
```

That installs ffmpeg, Xvfb, PulseAudio and the Chromium libraries, then the npm
packages and Playwright's Chromium.

**Node 22.4.0 or newer.** `@dank074/discord-video-stream` requires it. Node 20
runs everything except the Discord streaming step.

`npm run setup` also downloads Playwright's Chromium, which `npm install` does
not do on its own. If you skipped setup, run it separately:

```bash
npx playwright install chromium
```

Without it the browser capture path cannot start. The tests detect that and
skip rather than fail, telling you the command to run.

To check the machine afterwards:

```bash
node scripts/diagnose.js
```

This runs the whole capture pipeline against a locally generated test clip. It
needs no token and no network.

## Configure

```bash
cp .env.example .env
```

Then edit `.env`. The variables that matter:

| Variable | What it is |
| --- | --- |
| `DISCORD_USER_TOKEN` | The throwaway account the streamer logs in as |
| `DISCORD_BOT_TOKEN` | The application bot that owns `/stream` |
| `DISCORD_CLIENT_ID` | That bot's application id, for registering the command |
| `GUILD_ID` | Where to register the command. Leave empty for global, which takes up to an hour to appear |
| `ALLOWED_ROLE_IDS` | Roles allowed to press panel buttons. Empty means only the requester |
| `IPC_TOKEN` | Shared secret between the two processes on localhost |
| `PLAYER_BACKEND` | Ignored. Playback is the browser only |
| `MEGAPLAY_MIRRORS` | Comma separated fallback hosts |
| `TMDB_API_KEY` / `FANART_API_KEY` | For transparent logos. Optional |

Tokens live only in `.env`, which is gitignored. They are never written to the
log; the log redaction is in `shared/src/http.js` and is covered by a unit test.

Check the tokens are real before starting anything:

```bash
node run.js check
```

This asks Discord about each token and tells you which account each one is. It
prints the account name, never the token.

## Run

```bash
node run.js
```

The first thing it does is kill whatever is listening on port 8787, so a stuck
streamer from the last run cannot block the new one. It then installs anything
that is missing (system packages, npm packages, Playwright Chromium) and starts
both processes. Output is prefixed so you can tell them apart, and Ctrl-C stops
them together. Either half can also run on its own:

```bash
node run.js streamer
node run.js controller
```

They are separate processes on purpose, so a crash in one does not take the
other down, and you can restart the streamer without dropping the panel.

## Using it

```
/stream anime:oni poice episode:1 audio:sub
```

- `anime` is a name, not a MAL id. Typos are resolved, then the id is looked up
  and the fetched title has to match before playback starts. Captions start on.
  There is no captions option.
- `episode` is optional. It defaults to the last watched episode, or 1. A movie ignores it and starts at episode 1.
- `audio` is `sub` or `dub`. If no dub exists you get the sub and the panel
  says so.

`/continue` offers the anime names saved for you, such as One Piece or Berserk.
The choices do not include an id or an episode number. `/history` posts a
public numbered container of those names, each ending in a Discord timestamp.
`/help` and `/ping` use the same container design. `/streamer` lists the
accounts that can Go Live. `/np`, `/play` and `/resume` are not registered.
Every restart deletes the bot's commands and adds them again.

Progress is saved periodically to `PROGRESS_FILE`, so it survives a restart.

The panel heading is the episode title, linked to a Google search. The body is:

```
**Type** : `Series`
**Duration** : `6:07/23:57`
**Language** : `Sub`
**Episode** : `1/1000`
**Autoplay** : `Enabled`
**Captions** : `Enabled`
```

Type is `Series` or `Movie`. A movie does not show the episode line. Language
is `Sub` or `Dub`. Autoplay and captions are `Enabled` or `Disabled`. The
container is blue while it is playing and green when the episode is finished.
Stopped or failed playback is red. The main row is five emoji buttons: previous
episode, back 10 seconds, pause or resume, forward 10 seconds, next episode.
**More options** opens a private panel with Player, Volume, Toggles and
Miscellaneous. Custom volume accepts 1 to 500 percent. Seek and Custom open a
form, and that form has to be the first reply to the click.

Autoplay is on by default. When an episode ends, the Go Live stops. The old
message keeps its title and thumbnail, drops the info lines, turns green, and
disables the buttons. If autoplay is still on, Jinx starts a new stream of the
next episode and posts a new panel in that same channel. Set
`AUTOPLAY_DEFAULT=false` to stop after the current episode.

`/streamer` lists accounts as `@user - Active` or `Inactive`, with a lock for
private and an open lock for public. Add asks for a user token and an optional
voice channel. A channel keeps that account in the channel. No channel means it
joins the requester's channel, or a random voice channel if they are not in
one. Public accounts come from `PUBLIC_STREAMERS` in `.env`, as
`token` or `token@channelId`. Tokens are stored in `Streamer.json` and are not
shown in the menu. On login the account display name is set to Streamer A,
Streamer B, and so on. The bot sets the voice channel status to the anime name
and episode.

Only the person who started playback, or a role in `ALLOWED_ROLE_IDS`, can press
the buttons. Everyone else gets a message that only they can see.

## Architecture

```
                     Discord
                        |
        +---------------+----------------+
        |                                |
   user token                       bot token
        |                                |
  +-----v------+                   +-----v-------+
  |  STREAMER  |                   | CONTROLLER  |
  |            |                   |             |
  | selfbot    |                   | /stream     |
  | voice      |                   | panel       |
  | Go Live    |                   | progress    |
  +-----+------+                   +-----+-------+
        |                                |
        |        HTTP on 127.0.0.1       |
        +<-------------------------------+
        |   play pause resume seek       |
        |   skip stop status             |
        |
  +-----v------+
  |   PLAYER   |
  |            |      megaplay.buzz
  | resolve  --+--->  embed page -> getSources -> master.m3u8
  | proxy      |
  | browser    |      Chromium + hls.js, borderless, on Xvfb
  | capture    |      x11grab + PulseAudio null sink
  |            |           |
  | watchdog   |      ffmpeg -> 1080p source-fps H.264 + Opus, NUT out
  +-----+------+
        |
        v
  @dank074/discord-video-stream -> Discord voice
```

Folders:

- `shared/` protocol, panel layout, time parsing, the megaplay client, progress
  storage. No Discord and no video in here, which is why it is fully unit
  testable.
- `player/` resolves an episode, proxies the HLS, plays it, captures the screen,
  watches for a frozen picture. Knows nothing about Discord.
- `streamer/` the selfbot. Owns the IPC server and the voice connection.
- `controller/` the application bot. Owns the command, the panel and the
  progress records.

The separation is enforced by what each folder imports, not by convention:
`controller/` never imports `player/`, and `streamer/` has no command handlers.

## Why it is built this way

One line per decision that is not obvious.

- **Two processes, not one.** Discord video streaming needs a user token, and
  an application bot cannot do it. Keeping them apart means the rule-breaking
  half is small, isolated and easy to stop using.
- **IPC over localhost HTTP rather than a library.** Both halves restart
  independently, and the traffic is readable with `curl` when something goes
  wrong.
- **A loopback bind plus a bearer token.** Loopback already limits who can
  connect; the token stops other processes on the same box from driving it.
- **Chromium on Xvfb rather than a headless decode.** Go Live streams a screen,
  so the simplest correct thing is to render a real page and capture it. It also
  means the captions, the black bars and the fullscreen behaviour are whatever
  a browser would do, not a reimplementation of them.
- **Browser only.** The direct ffmpeg playback path was removed. Capture still
  uses ffmpeg, but only to record the browser window.
- **A local HLS proxy.** It restamps the lying `Content-Type`, gives paths real
  extensions so FFmpeg's demuxer accepts them, and keeps one place to add the
  `Referer` header.
- **Components V2 with no embed.** A Container is only accepted on a message
  flagged `IsComponentsV2`, and the flag has to go on the deferral that creates
  the message, not on a later edit. The accent colour is the playback state:
  blue while playing, green when finished, red when stopped.
- **Progress keyed per user, per episode.** Two people watching the same episode
  should not share a resume point.
- **An episode end stops the Go Live, then autoplay starts a new one.** The
  engine marks the episode ended instead of restarting a frozen last frame.
  The streamer calls stopStream and leaves voice, so Discord actually drops
  the stream. The controller then turns the old panel green and, if autoplay is
  on, posts a new message for the next episode.
- **The audio sink runs at 48 kHz, and Chromium reaches it through ALSA.**
  PulseAudio's default rate is 44100, and Discord wants 48000. The Playwright
  Chromium build is linked to ALSA, not Pulse, so an asoundrc routes its
  default device into the null sink. Without that, the capture records silence.
- **The two halves use different discord.js versions.** The selfbot fork is
  built on v13, while the controller uses real v14. That split is easy to get
  wrong: v13 has `Intents` and `channel.isVoice()`, v14 has `GatewayIntentBits`
  and `channel.isVoiceBased()`. The selfbot Client also hardcodes `Intents.ALL`
  and warns if you pass `intents`, so the streamer passes no options at all.

## Testing

One command runs everything:

```bash
npm test
```

Or individually:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:chaos
SOAK_MINUTES=30 npm run test:soak
```

### Results on this machine

Debian 13, 2 CPUs, 2 GB RAM, ffmpeg 7.1.5, Node 20.20.2.

| Suite | Tests | Result | What it actually exercises |
| --- | --- | --- | --- |
| unit | 117 pass, 1 skip | pass | Panel layout, streamer roster, command list, name scoring, history timestamps. The 48 kHz sink test skipped because pulseaudio is not installed |
| integration | not re-run | | Needs the browser stack. Not run after the 1080p change |
| e2e | not re-run | | Chromium is not installed in this sandbox |
| chaos | not re-run | | Same reason |
| soak | not re-run | | Same reason |

Do not treat any earlier suite total as covering this build. A separate live
name check, not part of the unit count, mapped `oni poice`, `one peice`,
`berserkk`, `atack on titan`, `demonslayer` and `narutoo` to the expected
series and confirmed each fetched title. That is not a Discord click-through.

The soak defaults to one minute so the full run stays quick. The 30 minute
result from the earlier sandbox is not repeated here.

### What the tests are not

The integration suite talks to a **mock**, not to megaplay.buzz. The mock was
written from recorded responses and reproduces the awkward parts on purpose,
but a mock cannot catch the API changing. `docs/API.md` has the curl commands
to re-check by hand.

The e2e tests capture a **locally generated** clip, not a real episode. That is
deliberate: it makes the tests hermetic and keeps them off someone else's CDN.

## What has not been verified

Stated plainly, because a claim that was not tested is worse than no claim.

**Needs real credentials, so not tested here:**

- Logging in to Discord with either token.
- Registering the slash command and seeing it in a real server.
- Joining a voice channel and a real person seeing the Go Live stream.
- The panel appearing, and buttons and the seek modal responding in a real
  channel.
- Autoplay advancing inside a real Discord channel. The handoff (end the
  stream, disable the old panel, post a new message) is covered by unit tests
  of the decision and the panel payload, not by a click in a server.

**Needs a real account, so not tested:**

- Playing a real megaplay episode end to end into Discord. Resolution, the proxy
  and the capture are each tested against recorded shapes and local media, but
  the full chain with a real episode and a real viewer has not been run.

**Untested because it needs keys:**

- TMDB and fanart.tv transparent logos. Without keys the thumbnail is the
  AniList cover, which is a real image URL, not a transparent logo.

**Known environment gap:**

- This box runs Node 20.20.2. `@dank074/discord-video-stream` declares
  `engines >=22.4.0`. The streaming step is installed and its API was read, but
  it was not exercised. Chromium and ffmpeg are not available in this shell, so
  the 1080p capture path was not run here.

**Titles and thumbnails:**

- AniList resolves a MAL id without a key. MAL 21 comes back as One Piece with
  a cover URL, which is what the thumbnail uses when no TMDB or fanart.tv key
  is set. Kitsu's `filter[malId]` returns 400, so that filter is not used.
  Jikan is only a fallback and has timed out from this network before.

## Troubleshooting

**`node run.js check` says a token is not valid.** Discord rejected it. A user
token and a bot token are not interchangeable; `DISCORD_USER_TOKEN` takes the
raw user token and `DISCORD_BOT_TOKEN` takes the application bot token.

**The command does not appear.** With `GUILD_ID` set it appears immediately.
Global registration takes up to an hour.

**Black screen but audio works, or nothing at all.** Run
`node scripts/diagnose.js`. It tells you which part of the pipeline is broken
instead of making you guess.

**The streamer says the box is out of memory.** Check for leftovers:

```bash
pgrep -af 'ffmpeg|Xvfb'
```

The streamer sweeps its own leftovers on start and on exit, and it only ever
matches processes it started itself, so it will not touch an unrelated ffmpeg.
If something survived anyway, it means a crash path is missing, which is worth
reporting.

**A dubbed episode plays in Japanese.** That is not a bug in the panel. It
means no dub exists. The language line says Sub.

**Resolution fails with a 403.** The media hosts rotate and expire. Wait a
moment and try again, or add hosts to `MEGAPLAY_MIRRORS`.

## Files

```
run.js                     starts both, or one, or checks the setup
scripts/setup-vps.sh       installs system packages
scripts/diagnose.js        checks the capture pipeline with no token
scripts/run-all-tests.sh   what `npm test` runs
docs/API.md                the megaplay API, as observed
.env.example               every variable, no commentary
```
