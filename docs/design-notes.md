# Design notes

Why the parts that are not obvious are built the way they are. Almost every entry here exists
because something behaved unexpectedly first, and the note is the reason not to undo the fix.

## The score is closeness weighted by lateness, plus an escape hatch

Each live game gets a 0-100 score. The dominant term is how close it is, scaled by how far into
the game it is, because a tie in the first quarter is not the same event as a tie with ninety
seconds left. Tension is multiplied by `0.2 + 0.8 * progress²`.

That alone is not enough, and the reason is the 2026 Western Michigan at Michigan game. Down
five with the ball and thirty seconds left, Michigan had a **1% win probability**. The model
scored the most exciting drive of the week a **10 out of 100** while the game-winning touchdown
was in the air.

Win probability answers "who will win". That is a different question from "is something about
to happen". So there is a second term, `clutch`, for a one-score game inside the final five
minutes, weighted by whether the *trailing* team has the ball. The primary term is
`max(core, clutch)`, so a game qualifies on either. With `clutch` in place the same drive peaks
at 88, and the game sits above 55 for 43 of its 44 fourth-quarter plays.

Possession discounts rather than gates: the leader running out the clock still scores 0.6, not
zero, because the trailing team needing a stop is genuinely tense. Discounting also stops the
board lurching every time possession changes.

## Upset detection, and why it does not use live odds

ESPN removes the betting line from a game the moment it kicks off, so the obvious approach is
unavailable. The first version used the AP rank gap instead, treating unranked as rank 40.

That is too crude, and it produced a visible false positive on the first night it ran. SMU
(#19) at Florida State (unranked) was tagged `UPSET ALERT` at 24-24 in the fourth. But the
market had SMU as a **3-point favourite**, so a tie was the expected result. Rank gap cannot
tell a 3-point coin flip from a mismatch, and it rated Michigan, who were **27.5-point
favourites**, identically.

The fix is the **pregame closing line**, and no second data provider is needed. ESPN keeps it
in `pickcenter` on the summary endpoint, and it survives kickoff and the final whistle. Lines
are captured from the scoreboard while a game is still pregame; a game already live when the
process starts gets one `summary?event=<id>` lookup, cached permanently, since a closing line
never changes.

```
market = clamp((expectedDeficit - actualDeficit) / 21) * (0.4 + 0.6 * progress)
upset  = line ? max(market, 0.6 * rankUpset) : rankUpset
```

Rank survives at 60% strength deliberately. An unranked team beating a ranked one is a real
story even when the market called it even, it is just not the same event as a 27-point underdog
hanging around.

| Situation | Line | upset |
| --- | --- | --- |
| WMU tied with Michigan | MICH -27.5 | 0.95 |
| FSU tied with SMU | SMU -3 | 0.38 |
| #20 tied with #22 | -2 | 0.09 |

**The spread is home-relative**: negative means the home team was favoured. Verified against
twelve games before relying on it, because getting the sign backwards silently inverts which
team is the underdog.

## Never trust the ESPN "current week" pointer

The default scoreboard response returns whatever ESPN considers the current week, and **that
pointer rolls over at midnight ET while games are still being played**. A game kicking off at
10:30pm ET vanishes from the response partway through the fourth quarter. The board reported
nothing live while a game was being watched.

The live poller therefore asks for an explicit `dates=<yesterday>-<today>` range. Any change to
how games are fetched has to preserve that, or every late kickoff silently disappears again.

## ESPN drops the situation block mid-game

`situation.lastPlay.probability`, `possession` and `downDistanceText` all go null for stretches
during a live game, sometimes for minutes. This is normal, not an outage.

Closeness therefore falls back to a margin curve that tightens as the clock runs down. A
finished game uses a third, more forgiving curve, because the question for a final is "was that
a good one", not "can it still change". At 0:00 the live curve writes off any two-score game,
which rated a 27-34 finish a 10.

## Tags must not promise more than the number supports

Three renames, all the same mistake:

- `WILD SWINGS` implied a property of the game. The number underneath is a rolling
  fifteen-minute window that decays, so the tag appeared and then vanished. It is now
  `RECENT SWINGS`. The window is right for this board: a game that was chaotic an hour ago but
  is now a blowout should not be advertised as wild.
- `COMEBACK LIVE` named a comeback the condition does not require. It fires on a tied game,
  where nobody is coming back, and on a leader defending a lead. It is now `GAME ON THE LINE`,
  and it suppresses `ONE SCORE, LATE` rather than stacking with it.
- `UPSET ALERT` fired while the underdog was **losing**, because the score gives credit for
  merely hanging around. The score still does, since that is right for ranking, but the tag now
  additionally requires the underdog to be level or ahead. `UPSET POTENTIAL` covers
  behind-but-within-one-score late.

The hero label follows the same discipline. It only says `TURN THIS ON` above 75, and degrades
to `BEST GAME ON` and `BEST OF WHAT IS ON`, because shouting at a mediocre 30 on a quiet
weeknight is the same overpromise.

## Polling is adaptive because the endpoint is undocumented

The ESPN scoreboard is public and undocumented with no published rate limit, so the poller is
conservative rather than trusting one. Thirty seconds while games are live, five minutes when
none are, which avoids roughly 3,000 requests a day for no benefit outside game windows. When
idle it schedules the next poll for just after the next kickoff, so nothing is missed by more
than one interval. Consecutive failures back off exponentially, and HTTP 429 is handled
explicitly, honouring `Retry-After`.

## Planning ahead is a different question

Games that have not kicked off get a separate `anticipation` rating, driven mostly by the
spread, because nothing we compute beats the market at predicting a close game.

Note the asymmetry with the live score. Pregame `quality` takes the **worse** of the two teams,
since planning an evening around a mismatch is a bad idea however good the favourite is.
`prominence` takes the **better**, since one blue blood is enough to put a game in the national
conversation. Broadcast slot feeds prominence too: networks allocate their best inventory to the
games they expect to draw, so ABC and NBC rate far above ESPN+.

The list is grouped by day, days in chronological order, ranked within each day. You plan Friday
before you plan Saturday, so a better Saturday game must never outrank an earlier day's.
Grouping happens on the client so day boundaries land in the viewer's timezone. The server
therefore returns a generous slice: slicing by score alone would let a busy Saturday push an
entire earlier day off the list.

## Verifying the model against real games

`scripts/replay.ts` replays a finished game play-by-play through the live model and prints what
the board would have shown at every snap. This is how the missing `clutch` term was found.

```bash
curl -s "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=401858428" -o game.json
HOME_CONF=5 AWAY_CONF=15 HOME_RANK=16 npx tsx scripts/replay.ts game.json
```

**Pass the CONF and RANK variables.** The summary endpoint omits `conferenceId` and
`curatedRank`, which the scoreboard carries, and without them the replay silently scores both
teams as unranked FCS and understates everything. That produced a full round of wrong
conclusions before it was noticed.

## Serving

The service worker is network-first for HTML and cache-first only for content-hashed `/assets/`.
An earlier version was cache-first on `index.html`, which meant a deploy did not reach a phone
until the *second* load, and quietly hid two fixes. `/api/*` is never cached, because a stale
scoreboard is worse than no board.

The static handler decodes the request path inside a try/catch. `decodeURIComponent` throws
`URIError` on input like `/%ZZ`, which was an uncaught exception in the request listener and
took the whole process down: one malformed URL, no auth required. The traversal check is
separator-aware, since a bare `startsWith` on the dist path would also accept a sibling
directory. Only GET and HEAD are accepted.

## Untested as of the first live run

The first night it ran there was exactly one live game, so **ranking was never exercised**.
Sorting, the hero pick, the "also live" list and the effect of the weight profiles on ordering
are all unvalidated against a real slate. Worth watching on a full Saturday: 41% of polls
cleared 55 with a single merely-decent game, which suggests the scale may be generous once
forty games are live.

## Regenerating the screenshots

The README shows four panels: live and upcoming, for each league. Only the upcoming pair can be
photographed from the real board, because a live board only exists while games are being played,
and waiting for a Sunday to document a UI change is not a workflow. The alternative, shipping
stale images, is what actually happened: the original pair went three features out of date before
anyone noticed, still showing a college-only app with no league tabs, favourites or market
control.

So the live pair is fabricated, carefully. Teams, records, lines, networks and listings come from
the real ESPN slate. Only the scores, clocks and situations are invented, and the ratings on the
cards are produced by importing the real scoring model rather than being typed in, so a
screenshot can never show a number the board would not itself produce.

Two details were learned the hard way and are worth keeping:

- **The fabricated game has to fit its real line.** The first attempt took the first six games on
  the slate, which in week one are FCS visitors at 45-point underdogs. A 24-23 fourth quarter
  there is nonsense, the model correctly screams `UPSET ALERT` at every card, and the picture
  stops describing a normal Saturday. The pool is now filtered to games inside ten points, ranked
  teams first.
- **Records have to be invented too.** In week one every team is 0-0, and a board full of `0-0`
  photographs as broken rather than as representative.

The postal code in the shots is `10001`, deliberately generic. The feature is worth showing but a
README is a public page.

```bash
npm run build
PORT=8790 DIST_DIR=dist node dist-server/server/index.js &   # upcoming shots read the real board

node scripts/mock-board.mjs --mode live &
node scripts/capture-screens.mjs live

node scripts/mock-board.mjs --mode upcoming &
node scripts/capture-screens.mjs upcoming
```

Headless Chromium comes from Playwright, a dev dependency, rather than a browser already on the
machine. Edge here writes no file at all and reports no error, headless or not. Firefox does work
but shares process space with whatever the user has open, and filtering its processes by start
time to clean up kills content processes belonging to their real session.

**Regenerate whenever the board's layout or chrome changes**: the header and controls, the card
or row structure, the tag set, or anything that changes what a glance at the board looks like. A
scoring tweak that only moves numbers does not need new pictures.
