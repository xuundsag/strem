# The megaplay API, as observed

Everything here was recorded by making the requests and reading what came
back, not from documentation. megaplay.buzz publishes no API docs; `/api/docs`,
`/api/swagger.json`, `/api/openapi.json` and `/ajax/*` all return 404.

Observations were made from a plain Debian box with `curl`. Dates are given
because this is an unofficial API and it can change without notice. If
something stops working, re-run the checks in section 8.

Nothing in this project depends on an undocumented detail that is not listed
here.

## 1. Addressing an episode

The player is a web page, addressed by anime id and episode number.

```
GET https://megaplay.buzz/stream/mal/{malId}/{episode}/{lang}
GET https://megaplay.buzz/stream/s-2/{episodeEmbedId}/{lang}
GET https://megaplay.buzz/stream/ani/{anilistId}/{episode}/{lang}
```

`{lang}` is `sub` or `dub`. This project uses the MAL route, because the whole
product is specified around MAL ids.

### The Referer header is required

Without it the request fails. With it the page comes back normally.

```
Referer: https://megaplay.buzz/
User-Agent: <a normal browser string>
```

An earlier note in this project claimed the MAL route returned HTTP 410. That
was wrong. The missing `Referer` was the cause.

### A missing episode is not an HTTP error

Asking for an episode that does not exist returns **HTTP 200** with an error
page in the body:

```html
Error Code: <span>404</span>
```

So a client that only checks the status code will happily try to parse an error
page as a player page. `shared/src/megaplay.js` looks for that text and reports
it as "not available" instead of retrying.

### A missing dub is not an error either

Asking for `dub` when only a sub exists returns the **sub** player page with
`type: 'sub'` written into `window.settings`. The client has to compare what it
asked for against what it got. That comparison is what produces the
"Dub unavailable, falling back to sub" message in the panel.

## 2. The player page

The response is HTML. The interesting parts:

```html
<div ... data-id="178727" data-realid="..." data-mediaid="...">
<script>window.settings = {"type":"sub","cid":"...","cidu":"...","autoSkipIntro":...}</script>
```

- `data-id` is the value the source endpoint wants.
- `window.settings.type` is the language actually being served.

The page also loads `lib/newclient.min.js`, `lib/app.main.js`,
`lib/handle-bridge.min.js` and `lib/e1-player.min.js`. `handle-bridge` accepts
`SKP_DATA`, `PLAY_TOGGLE`, `MUTE` and `GET_PIP` messages. This project does not
use any of them; the video is played in our own page.

## 3. Getting the media

```
GET https://megaplay.buzz/stream/getSources?id={data-id}&platform=OTHER
```

Response:

```json
{
  "tracks": [ { "file": "https://<host>/anime/<a>/<b>/subtitles/en.vtt", "label": "English" }, ... ],
  "t": "...",
  "intro": { "start": 31, "end": 111 },
  "outro": { "start": 1376, "end": 1447 },
  "server": 4,
  "image": "...",
  "enc": "..."
}
```

`platform=OTHER` returns all nine caption languages. Without it the list is
shorter.

`intro` and `outro` are in seconds and either field can be `null`. Observed
values:

| Episode | intro | outro |
| --- | --- | --- |
| One Piece (MAL 61607) ep 1 | 31 to 111 | 1376 to 1447 |
| Link Click S3 ep 1, dub | null | 1214 to 1300 |

These two numbers are what the Skip button uses.

## 4. Finding the playlist

The media path is in plaintext inside any track URL. Take

```
https://<host>/anime/<a>/<b>/subtitles/en.vtt
```

and the master playlist is

```
https://<host>/anime/<a>/<b>/master.m3u8
```

`shared/src/urls.js` does exactly this rewrite, and it carries the scheme over
rather than forcing `https`, because a mirror may be plain http.

## 5. The master playlist

```
GET https://<host>/anime/<a>/<b>/master.m3u8
Referer: https://megaplay.buzz/
```

Only the `Referer` header is needed. Three variants, observed:

| Variant | Resolution | Bitrate |
| --- | --- | --- |
| index-f1 | 1920x1080 | about 5.5 Mbps |
| index-f2 | 1280x720 | about 2.8 Mbps |
| index-f3 | 640x360 | about 0.8 Mbps |

## 6. Segments

Segments are absolute URLs on rotating hosts, four seconds each, with
deliberately disguised filenames and a **lying** `Content-Type: image/jpeg`.
The bytes are genuinely MPEG-TS H.264.

Two consequences this project handles:

- `player/src/hls-proxy.js` restamps the content type as `video/mp2t` and gives
  the paths real `.m3u8` and `.ts` extensions. Without real extensions FFmpeg's
  HLS demuxer refuses them with `is not in allowed_segment_extensions` and exits
  183. `-allowed_extensions ALL` does not help.
- Never trust the content type for anything.

One segment measured at 47,401,110 bytes.

## 7. Domain fallback

```
GET https://megaplay.buzz/lib/check_domain.json
```

Observed response:

```json
{ "fallback": "xdw5v.qeltrix.top", "failed": [] }
```

The hosts rotate and expire. A master URL that worked minutes ago can return a
403 from Cloudflare later, which is normal and is why resolution is retried
against the mirrors in `MEGAPLAY_MIRRORS` rather than cached.

## 8. Re-checking all of this

```bash
# player page, and the type it actually serves
curl -s -H 'Referer: https://megaplay.buzz/' -H 'User-Agent: Mozilla/5.0' \
  'https://megaplay.buzz/stream/mal/21/1/sub' | grep -oE 'data-id="[0-9]+"|"type":"[a-z]+"'

# sources, intro and outro
curl -s -H 'Referer: https://megaplay.buzz/' \
  'https://megaplay.buzz/stream/getSources?id=36396&platform=OTHER'

# current fallback host
curl -s 'https://megaplay.buzz/lib/check_domain.json'
```

The integration suite does the equivalent against a mock that reproduces these
shapes, including the 200-with-error-page behaviour and the lying content
types. Run it with `npm run test:integration`.

## 9. What is not here

- **Anikoto** (`anikotoapi.site`) has `/recent-anime` and `/series/{id}`, where
  the latter returns `episode_embed_id` and an `embed_url` per episode. It is
  rate limited to 60 requests per IP per 120 seconds and has **no MAL lookup**;
  five different URL shapes were tried and all returned 404. It is not used.
- **Jikan v4** timed out when queried. **Kitsu** rejects `filter[mal_id]` with a
  400. `shared/src/metadata.js` tries both, guarded, and falls back to whatever
  it can get. Title, logo and episode count may be missing, and the panel is
  built to cope with that.
- Token minting, decrypting the `domains` payload, and static analysis of
  `e1-player.min.js` were all attempted and are dead ends. The player runs its
  script inside an eval VM.
