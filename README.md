# <img src="public/icon-192.png" width="32" align="absmiddle" alt=""> Football: What Should I Be Watching

A live board that answers one question: **which football game should I have on right now?**

Rankings and records tell you which games *matter*. They do not tell you which game is
currently a one-score fight with four minutes left. This polls the public ESPN scoreboard and
ranks every in-progress game by how good it is at this moment, then ranks the week ahead by how
much each matchup is worth planning around.

Covers the **NFL** and **college football** on separate tabs, each with its own calibration.

No API key, no account, no database.

> **The screenshots below use test data.** Scores, clocks and records are fabricated, and the
> slate is whichever week they happened to be captured in, so nothing shown is a real assessment
> of any game.

| | What is on right now | What to plan around |
| --- | --- | --- |
| **NFL** | <img src="docs/nfl-live.png" width="330" alt="Live NFL board"> | <img src="docs/nfl-upcoming.png" width="330" alt="Upcoming NFL games grouped by day"> |
| **College** | <img src="docs/cfb-live.png" width="330" alt="Live college board"> | <img src="docs/cfb-upcoming.png" width="330" alt="Upcoming college games grouped by day"> |

<sub><a href="docs/design-notes.md">Design notes</a> cover how these are regenerated.</sub>

## What the board shows

**Live games**, best first. Each card carries the score, live win probability, the clock and
situation, who has the ball, the network, the pregame line, and any tags that apply:
`GAME ON THE LINE`, `UPSET ALERT`, `RECENT SWINGS`, `INSTANT CLASSIC`, `OVERTIME`.

**Worth planning around**, grouped by day, days in order, games ranked within each day, so an
earlier day's games are never buried under a better game later in the week. Each row shows
kickoff time, the line, the over/under and the network.

**Just finished**, the recent recap, best first. Games stay on the board for eighteen hours.

**Alerts**, optional, off by default. Five kinds, chosen per league: a game becoming worth
switching to, one turning into something memorable, an upset in progress, the pick of a busy
kickoff window, and NFL primetime, where the only game in its slot is starting and the alert says
plainly how good it is expected to be. At most three a day per league, never for a game your
market is not carrying. The screen stays awake while the board is open.

**League tabs** switch between NFL and college; the NFL opens by default. **Favourite
conferences** push the games you care about up the board, weighted higher when both teams
qualify than one. Tab, favourites and market all persist in the browser.

## How the score works

Every live game gets a 0-100 score and the board sorts on it.

**The main term is how close the game is, weighted by how late it is**, since a tie in the first
quarter is not the event a tie with ninety seconds left is. Closeness comes from ESPN's live win
probability, falling back to a margin curve when ESPN stops publishing one.

**A second term catches what win probability misses.** A team down five with the ball and thirty
seconds left has a terrible win probability and is the most watchable thing on television, so
one-score games inside the final five minutes get a `clutch` score. The dominant term is
whichever of the two is higher.

Five smaller components adjust it, with fixed weights:

| Component | What it measures | Weight |
| --- | --- | --- |
| `primary` | Closeness, weighted by how late | 0.58 |
| `prominence` | How much of the country cares | 0.18 |
| `swing` | Win-probability movement over the last fifteen minutes | 0.08 |
| `upset` | How far the underdog is running ahead of the closing line | 0.07 |
| `stakes` | What the game decides | 0.05 |
| `pace` | Projected total points, so a 45-38 beats a 10-7 | 0.04 |

The components are the same for both leagues; what feeds them is not.

| Component | College | NFL |
| --- | --- | --- |
| `prominence` | Conference tier, best AP rank, broadcast slot | Best record, best playoff seed, kickoff slot |
| `upset` | Closing line, rank gap as fallback | Closing line, record gap as fallback |
| `stakes` | Both ranked, both top-10, conference game | Division game, both contenders, both winning |
| `pace` | Scaled around a 55-point total | Scaled around a 45-point total |

Upcoming games get a separate `anticipation` rating, driven mostly by the spread.

Why each term is shaped the way it is, and the games that forced those decisions, are in
[docs/design-notes.md](docs/design-notes.md).

### What a number means

| Pregame | Reads as |
| --- | --- |
| 80+ | Rare. Two good teams, tight line, big slot |
| 70-79 | Clear the evening |
| 55-69 | Worth having on |
| under 55 | Background noise |

Read each tab against itself; the two leagues produce different distributions. Pregame
`anticipation` and the live score are different scales too. On the live board, `TURN THIS ON`
fires at 75.

## Can I actually watch it

A great game you cannot get is not a recommendation. On Sunday afternoons the networks split the
slate by market: eight games kick at 1:00, but only one CBS and one FOX game reaches any city.

The board reads the Gracenote listings grid for your postal code and reports which of them your
own affiliates are carrying. Games your market is not showing keep their real score but fade back
and sort below the ones you can get.

Behind Cloudflare you do not have to type a postal code: switch on the managed transform *Add
visitor location headers* and the board uses `CF-Postal-Code` as the default market. The control
has three states, since "work it out for me" and "do not filter at all" are different requests: a
postal code you typed, the detected one, and explicitly off. **Clear** turns it off entirely and
**Redetect** goes back to the network's answer.

With no postal code from any source, nothing is flagged and the board behaves as though the
feature were not there.

## Running it

```bash
npm install
npm run dev
```

The Vite dev server comes up on <http://localhost:5180> and proxies `/api` to the poller on port
8787. `npm run dev:server` and `npm run dev:web` run the two halves separately.

Both halves bind all interfaces, so other devices on the LAN can load the board at
`http://<your-lan-ip>:5180`. Vite prints the reachable addresses on startup. To reach it by
hostname instead, set `ALLOWED_HOSTS=name1,name2`.

## Deploying

CI publishes an image to GHCR on every push to `main`. The compiled server has no runtime
dependencies beyond Node itself.

```bash
docker run -d --name football-watchability \
  -p 8787:8787 \
  -e TZ=America/New_York \
  --restart unless-stopped \
  ghcr.io/micahmo/football-watchability:latest
```

The board itself needs no volume and no database. All of it is in memory and rebuilds from ESPN
within a poll or two, so the container can be replaced freely. The only cost of a restart is that
win-probability swing history resets, which suppresses the `RECENT SWINGS` tag for about fifteen
minutes.

**Notifications are the exception**, because a push keypair and its subscriptions cannot be
rebuilt from anywhere. Mount a volume and point `NOTIFY_DIR` at it:

```bash
  -v /path/on/host:/config   -e NOTIFY_DIR=/config   --user 99:100 ```

The image runs as a non-root user and never chowns anything, so the uid has to match whoever owns
the volume. `99:100` is Unraid's appdata owner; elsewhere, use your own.

Without it the feature is simply unavailable and everything else is unchanged. The server checks
that the directory is really a mounted volume rather than trusting the variable, so a forgotten
`-v` hides the toggle instead of collecting subscriptions that vanish on the next update.

**Set `TZ` to US Eastern or near it.** The poller asks ESPN for "yesterday through today", and
those day boundaries are what keep a game running past midnight visible.

An Unraid template is included at [unraid/football-watchability.xml](unraid/football-watchability.xml).

### Behind a reverse proxy

Point the proxy at port `8787`. The app is a single origin serving both the page and its API, so
there is no path splitting and no CORS configuration. It sets no cookies and requires no auth
headers, so a plain `proxy_pass` is enough.

Serving it over HTTPS on a real hostname is also what makes it installable as a PWA. A browser
only offers to install from a secure context, which rules out plain-http LAN addresses.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API and static server port |
| `HOST` | `0.0.0.0` | Bind address |
| `TZ` | container default | Day boundaries for the scoreboard query. Use US Eastern |
| `DIST_DIR` | `../dist` | Built frontend location. Set in the container |
| `POLL_MS` | `30000` | Poll interval while games are live |
| `IDLE_POLL_MS` | `300000` | Poll interval when nothing is live |
| `ESPN_GROUPS` | `80` | ESPN group id, college only. `80` is FBS, `81` is FCS |
| `ESPN_DATES` | current range | `YYYYMMDD` or a range. Pins the board to a past slate |
| `SCHEDULE_DAYS` | `8` | How far ahead the planning list looks |
| `SCHEDULE_POLL_MS` | `600000` | Schedule refresh interval |
| `RECENT_WINDOW_HOURS` | `18` | How far back the recap reaches |
| `ALLOWED_HOSTS` | - | Extra hostnames the dev server answers to, comma separated |
| `NOTIFY_DIR` | - | Where to keep push keys and subscriptions. Must be a mounted volume |
| `NOTIFY_CONTACT` | - | `mailto:` address sent to push services with each delivery |

Replaying a past slate is the easiest way to see a full board on a quiet weeknight:

```bash
ESPN_DATES=20260905 RECENT_WINDOW_HOURS=120 npm run dev:server
```

## API

- `GET /api/snapshot?league=nfl|cfb` - the full ranked board (`live`, `upcoming`, `recent`)
- `GET /api/snapshot?league=nfl&zip=02134` - the same board, annotated with what that market is
  carrying. Ignored for college
- `GET /api/health` - per-league poller status, last update, failure count, next poll
- `GET /api/notifications/config` - whether alerts are available, and the public push key
- `POST /api/notifications/subscribe` - register a push subscription and its preferences
- `POST /api/notifications/unsubscribe` - drop one

Those two POSTs are the only writes the server accepts; bodies are capped at 8 KB and every field
is validated. Every other method and path returns 405.

## Layout

```
server/     per-league pollers, ESPN client, scoring model, prominence table,
            NFL standings, market listings, line and swing caches
shared/     types and scoring weights used by both halves
scripts/    replay tool for checking the model against finished games
src/        Svelte 5 dashboard
docs/       design notes
unraid/     container template
```

`npm run check` typechecks all three projects (Svelte app, Vite config, server).

## Known limitations

- **Rivalry and playoff-elimination stakes are not modelled.** Those are the two things the
  numbers genuinely cannot see, and both would need a hand-maintained list.
- Conference tiers are a static table in `server/prominence.ts` and need editing when
  realignment moves teams around.
- Where no closing line exists, mostly FCS matchups, upset detection falls back to the rank gap,
  which cannot tell a mismatch from a coin flip.
- Swing history is in memory only, so a restart suppresses `RECENT SWINGS` until it refills.
- Market listings are cached for six hours, so a lineup change can take that long to show.
- NFL prominence leans on records and seeding, so it is near-flat in week one when everyone is
  0-0 and sharpens as the season goes.
