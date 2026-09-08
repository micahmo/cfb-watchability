# <img src="public/icon-192.png" width="32" align="absmiddle" alt=""> College Football: What Should I Be Watching

A live board that answers one question: **which college football game should I have on right
now?**

Rankings and records tell you which games *matter*. They do not tell you which game is
currently a one-score fight with four minutes left. This polls the public ESPN scoreboard and
ranks every in-progress game by how good it is at this moment, then ranks the week ahead by how
much each matchup is worth planning around.

No API key, no account, no database.

| What is on right now | What to plan around |
| --- | --- |
| <img src="docs/board.png" width="420" alt="Live board"> | <img src="docs/upcoming.png" width="420" alt="Upcoming games grouped by day"> |

<sub>Real teams, lines and networks. In-game scores and clocks are illustrative.</sub>

## What the board shows

**Live games**, best first. Each card carries the score, live win probability, the clock and
situation, who has the ball, the network, the pregame line, and any tags that apply:
`GAME ON THE LINE`, `UPSET ALERT`, `RECENT SWINGS`, `INSTANT CLASSIC`, `OVERTIME`.

**Worth planning around**, grouped by day with days in chronological order and games ranked
within each day, so you plan Friday before you plan Saturday. Each row shows kickoff time, the
line, the over/under and the network.

**Just finished**, the recent recap, best first.

## How the score works

Every live game gets a 0-100 score, and the board sorts on it.

**The main term is how close the game is, weighted by how late it is.** A tie in
the first quarter is not the same event as a tie with ninety seconds left, so
closeness is multiplied by `0.2 + 0.8 * progress²`. Closeness itself comes from
ESPN's live win probability, falling back to a margin curve when ESPN stops
publishing one.

**A second term catches what win probability misses.** A team down five with the
ball and thirty seconds left has a terrible win probability and is the most
watchable thing on television. So one-score games inside the final five minutes
get a `clutch` score, weighted up when the *trailing* team has the ball. The
dominant term is whichever of the two is higher, so a game qualifies on either.

Four smaller components adjust it:

| Component | What it measures |
| --- | --- |
| `prominence` | How much of the country cares. Conference tier, best rank, and broadcast slot |
| `upset` | How far the underdog is running ahead of the pregame closing line |
| `swing` | Cumulative win-probability movement over the last fifteen minutes |
| `stakes` | Both teams ranked, both top-10, conference game |
| `pace` | Projected total points, so a 45-38 track meet beats a 10-7 slog |

`prominence` deliberately takes the **better** of the two programs. One blue blood
is enough to put a game in the national conversation, which is why a ranked team
struggling against a MAC opponent is a bigger story than an excellent Sun Belt
game. Broadcast slot feeds into it because networks allocate their best inventory
to the games they expect to draw, so ABC and NBC rate far above ESPN+.

`upset` uses the **pregame closing line**, not the ranking gap. Rank cannot tell a
27-point mismatch from a coin flip, and both can look like "ranked versus
unranked". A live line is no good either, because it moves with the game and prices
the surprise away. The ranking gap survives at 60% strength as a fallback, so an
unranked team beating a ranked one still registers.

### Weight profiles

Whether "the best game" means the closest game or the biggest one is a taste
question, so it is a control rather than a fixed answer. Each profile sums to 1.

| Profile | Closeness | Prominence | Reads as |
| --- | --- | --- | --- |
| Best game | 0.74 | 0.04 | Purely how close and how late |
| Balanced (default) | 0.58 | 0.18 | Closeness first, big programs break ties |
| Biggest game | 0.42 | 0.36 | Favour what the country is watching |

The server ships every component and the browser recombines them, so switching is
instant. A game with a 25-point margin past the 80% mark is capped at 8 regardless
of what the other terms think.

### Before kickoff

Upcoming games get a separate `anticipation` rating driven mostly by the spread,
since nothing we compute beats the market at predicting a close game. Note the
asymmetry with the live score: pregame quality takes the **worse** of the two
teams, because planning an evening around a mismatch is a bad idea however good the
favourite is.

Fuller reasoning, and the games that forced each of these decisions, are in
[docs/design-notes.md](docs/design-notes.md).

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
docker run -d --name cfb-watchability \
  -p 8787:8787 \
  -e TZ=America/New_York \
  --restart unless-stopped \
  ghcr.io/micahmo/cfb-watchability:latest
```

There are no volumes and no database. All state is in memory and rebuilds from ESPN within a
poll or two, so the container can be replaced freely. The only cost of a restart is that
win-probability swing history resets, which suppresses the `RECENT SWINGS` tag for about fifteen
minutes.

**Set `TZ` to US Eastern or near it.** The poller asks ESPN for "yesterday through today", and
those day boundaries are what keep a game running past midnight visible.

An Unraid template is included at [unraid/cfb-watchability.xml](unraid/cfb-watchability.xml).

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
| `ESPN_GROUPS` | `80` | ESPN group id. `80` is FBS, `81` is FCS |
| `ESPN_DATES` | current range | `YYYYMMDD` or a range. Pins the board to a past slate |
| `SCHEDULE_DAYS` | `8` | How far ahead the planning list looks |
| `SCHEDULE_POLL_MS` | `600000` | Schedule refresh interval |
| `RECENT_WINDOW_HOURS` | `10` | How far back the recap reaches |
| `ALLOWED_HOSTS` | - | Extra hostnames the dev server answers to, comma separated |

Replaying a past Saturday is the easiest way to see a full board on a quiet weeknight:

```bash
ESPN_DATES=20260905 RECENT_WINDOW_HOURS=120 npm run dev:server
```

## API

- `GET /api/snapshot` - the full ranked board (`live`, `upcoming`, `recent`)
- `GET /api/health` - poller status, last update, failure count, next poll

Both are read-only. Every other method returns 405.

## Layout

```
server/     poller, ESPN client, scoring model, prominence table, line and swing caches
shared/     types and weight profiles used by both halves
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
