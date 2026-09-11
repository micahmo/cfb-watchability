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

## Why the score terms are shaped the way they are

`prominence` deliberately takes the **better** of the two programs. One blue blood is enough to
put a game in the national conversation, which is why a ranked team struggling against a MAC
opponent is a bigger story than an excellent Sun Belt game. Broadcast slot feeds into it because
networks allocate their best inventory to the games they expect to draw, so ABC and NBC rate far
above ESPN+.

Pregame `anticipation` is driven mostly by the spread, because nothing computed here beats the
market at predicting a close game. It inverts prominence and takes the **worse** of the two
teams, because planning an evening around a mismatch is a bad idea however good the favourite is.
A 45-38 college shootout and a 27-24 NFL game are not the same event, which is why the two
leagues are calibrated separately rather than sharing one scale.

`upset` uses the **pregame closing line**, not the ranking gap. Rank cannot tell a 27-point
mismatch from a coin flip and both can look like "ranked versus unranked". A live line is no good
either, because it moves with the game and prices the surprise away. The rank gap survives at 60%
strength as a fallback, so an unranked team beating a ranked one still registers.

The NFL has no AP rankings and no conference tiers worth speaking of, so prominence there is
rebuilt from the standings feed: record quality, playoff seeding, kickoff slot. Slot carries real
weight because every NFL network is a major one, so a Sunday night game is a deliberate statement
about the matchup in a way that "it is on ESPN" is not in college.

The conference-favourite bonus is graded rather than binary: both teams, then one, then neither.
It shipped binary, which tied the first two tiers together and made a cross-conference game rank
level with an all-AFC one.

### The pace calibration bug

`pace` was calibrated for college totals and applied to both leagues. NFL over/unders run around
46 against college's 53, so an NFL game could never exceed 0.38 on that term. It flattened the
whole NFL board, and the top game never crossed the `TURN THIS ON` threshold at 75. Fixing it
moved the NFL top from 69.6 to 75.2. Worth remembering that a shared scale is a per-league
assumption in disguise.

### Three weight profiles, removed

An earlier version shipped selectable profiles trading closeness against prominence. Measured
against a full Saturday of finished games, the top-ranked game was **identical under all three**,
nothing moved more than two positions, and what movement there was landed at positions nine
through twelve. It never applied to the upcoming list at all. A control that cannot change the
answer is not a control.

### What the distribution looks like

A typical week, which is why each tab has to be read against itself:

```
NFL  n=15   top 75.2   median 64.8   low 47.1
CFB  n=60   top 87.8   median 45.4   low 38.4
```

College is bimodal: two genuinely great games, a cliff, then 46 of 60 below 55. The NFL is flat,
with 12 of 15 between 55 and 75. A 30-team league with a salary cap produces a uniformly
competitive slate; a 130-team one produces a few marquee games and a lot of filler. The live
score runs higher than pregame `anticipation` on the same game, since closeness-and-lateness
dominates once the clock starts, so a 70 pregame can become a 90.

## Working out which games a viewer can actually watch

ESPN is a dead end here and it took four sources to establish it. The scoreboard labels every NFL
game `National`, including the eight that are plainly regional. The `core` API carries real
station call signs, but only for preseason games. 506sports' coverage maps sit behind a bot wall,
and Gracenote's own commercial API needs a paid key. TitanTV works but is keyed to an account
GUID, which means asking every viewer to register and dig one out of devtools.

What does work is the public tvlistings grid, keyed on nothing but a postal code. It reports what
each local affiliate is airing hour by hour, so a 1:00 slate that looks identical on the
scoreboard comes back as "WBZ is showing Bills at Texans" in Boston and "WFRV is showing Bears at
Panthers" in Green Bay. It refuses non-browser user agents with a flat 403, so the request sends a
browser one; results are cached six hours per market with a cooldown after failures, which puts a
market at a handful of requests a week.

**Without a postal code nothing is flagged.** Regionality can be inferred from the slate alone,
since a network airing several games in one kickoff window is by definition splitting them by
market. But that fires on four-fifths of a Sunday board, and a badge on four-fifths of the rows is
wallpaper rather than a signal. Marking the other fifth "national" is no better, because the chip
already says NBC or ESPN and those *are* the national windows. So the board says it once, as a dot
on the market control, and otherwise stays out of the way. College is excluded from the inference
entirely: fifteen concurrent games under "ESPN+" are fifteen separate streams, not a market split,
and the same count would lie.

**A postal code alone is not always one market.** The grid's default is the over-the-air list,
which near a boundary sweeps in every transmitter the area could receive: Fitchburg MA returns
Boston, Providence, Manchester and Springfield affiliates together, and a viewer receives one
market's worth of those. The first fix only narrowed when the lists visibly disagreed, three or
more matchups in one window. That was too weak, because whether neighbouring markets happen to
show the same games in a given week is luck. It now always narrows through a satellite lineup,
which is scoped to the television market the postal code sits in and is the best available answer
to "which market is this really".

Nobody is asked to name their provider. The listings source has no streaming lineups at all, no
YouTube TV, Hulu Live or Fubo, only over-the-air, cable and satellite. That turns out not to
matter: every provider in a market carries the same local affiliates, and it is the affiliate that
decides which regional game you get.

**Call signs need care when normalising.** Stripping transmission-class suffixes blindly turns
WFLD, FOX Chicago, into "WF", and WWLP into "WW". A trim only stands if what it leaves behind is
itself a valid call sign: K or W plus two or three letters.

## Notifications

### Knowing whether there is anywhere to put them

Everything else here is a cache of ESPN that rebuilds within a poll or two, which is why the
container is disposable and a Force Update is risk-free. Push notifications break that: a VAPID
keypair that changes silently invalidates every subscription anyone ever made, and the
subscriptions cannot be rebuilt from anywhere.

So the feature is offered only when there is somewhere real to keep them, and the server works
that out rather than trusting configuration. A container cannot be told it has a volume, but it
can look at `/proc/self/mountinfo`: a mounted volume is a separate mount from the container's own
layer.

The signal is the **mount point**, not the filesystem type. Checking the filesystem looks right
and is wrong: it assumes the container's layer is `overlay`, and this deployment's host uses the
btrfs storage driver, so `/tmp` inside the container reports `btrfs` and sails through as real
storage. Found by running the check inside the actual container instead of trusting it. A path
still covered by the root mount is on the container's own layer; a path with its own deeper mount
was handed in from outside. Memory filesystems are excluded separately, because Kubernetes mounts
the service account token as tmpfs on its own mount and it would otherwise pass.

Verified against the live deployment:

```
/app       not-writable                    (the image runs as non-root)
/tmp       container-layer   btrfs         <- the case that fstype alone gets wrong
/dev/shm   memory            tmpfs
/data      missing
```

The one case nothing inside a container can detect is a disk-backed Kubernetes `emptyDir`, which
is indistinguishable from a PVC from the inside and dies with the pod. That stays a documentation
problem.

### When a notification fires

The principle is that a notification's job is to tell you that you are watching the wrong game.
It follows that a notification you cannot act on is worse than none, since it only tells you what
you missed, and that everything fires on a **transition** rather than a state: a game sitting at
82 for twenty minutes is one event, not forty polls.

| | Fires | Gate |
| --- | --- | --- |
| Turn this on | Boosted live score crosses 75 | At least 60s of game clock left |
| Instant classic | The same game later crosses 85 | None |
| Upset alert | Underdog level or ahead within one score, spread 7+ | Fourth quarter only |
| Kickoff | Best game in a window of four or more games | At kickoff |

Plus: seed state on the first poll after startup so a restart mid-slate announces nothing; one
notification per game per tier, ever; a global cooldown with simultaneous crossings coalesced into
a single message; a daily cap of three per league; and never notify about a game the market
lookup says is unavailable.

### How the thresholds were chosen

By replaying real games rather than by argument. ESPN's summary endpoint returns a
`winprobability` array joined to the play list, so a finished game can be pushed back through the
live scoring model play by play to reconstruct the score curve it would have had. For past
seasons the scoreboard drops the odds, but `pickcenter` still holds the closing line, so the
`upset` and `pace` terms can be fed properly.

A 71-game college Saturday:

```
T=70, 60s gate   -> 4 notifications
T=75, 60s gate   -> 2
T=75, 180s gate  -> 1
```

Four 2025 NFL Sundays, about 50 games:

```
T=70, 60s gate   -> 5, 4, 6, 3   (avg 4.5)
T=75, 60s gate   -> 3, 2, 6, 1   (avg 3.0)
T=80, 60s gate   -> 1, 1, 1, 0   (avg 0.8)
```

Two findings worth keeping. **The same threshold works for both leagues**, which the pregame
numbers suggest it should not: NFL `anticipation` tops out around 75 against college's 88, but
live peaks reach 87 against 92. Pregame is dominated by `prominence`, where college's blue bloods
run away with it; live is dominated by closeness and lateness, and NFL games are tight.

**The time gate is brutal because the model is built that way.** Lateness weighting means scores
only climb near the end, so most crossings happen inside the final two minutes and a three-minute
gate removes three quarters of them. Sixty seconds is the compromise: it keeps the genuinely
early crossings, which are the exceptional games worth interrupting someone for, and drops the
ones that crossed with twenty seconds left.

### The blowout upset the board could not see

UMass, 29.5-point underdogs, beat Rutgers 37-21. A 45.5-point swing against the line and the
story of that weekend. The model peaked it at **45.9** and would not have mentioned it, because it
stopped being competitive at halftime.

The cause is structural rather than a tuning error: `primary` carries 0.58 and measures closeness,
`upset` carries 0.07. On that game the `upset` term sat pinned at 1.00 for most of the second half
and moved the total by seven points. The board conflated "watchable" with "close", and a blowout
upset is neither close nor unwatchable.

What makes an upset compelling is not the margin, it is whether the improbable thing is going to
happen, which means it peaks while the result is still in doubt and drains once it is settled,
even as the winning margin grows. Reconstructed from that game:

```
Q1   7-7    underdog at 13%  ->  tension 0.06    still expected to lose
Q2  24-7    underdog at 67%  ->  tension 0.59    peak
Q3  27-7    underdog at 93%  ->  tension 0.25    decided
Q4  37-21   underdog at 100% ->  tension 0.00    over
```

Note the first quarter: level at 7-7 against a 29.5-point favourite scores almost nothing, and
that is correct. Being tied early does not mean much when there are three quarters for the gap to
reassert itself. The moment is the half.

So `upsetTension` became a third way to earn the dominant term, alongside `core` and `clutch`:
how far the underdog's live win probability has climbed from where the closing line put it,
multiplied by how much doubt remains. Magnitude survives the normalisation, so a 29.5-point
underdog reaching 67% outscores a 7-point underdog reaching 60%.

The game now peaks at **60.8**, at Q2 with UMass 24-7, and decays to 40.1 by the fourth. Checked
for collateral damage across a full college Saturday and an NFL Sunday: alerts went from 2 to 3
and 6 to 6, and seven college games reached 0.5+ on the new term without crossing the alert
threshold. Upsets rank better on the board without adding notification noise, which is right,
because an upset is a different kind of event and has its own alert category.

**The lesson generalises.** The same argument says the notification rule was wrong too: "underdog
ahead, within one score" measures the raw margin, and UMass were 16 ahead. The quantity that
matters is performance against the line, `underdog margin + spread`, which is +45.5 here against
+10 for a seven-point underdog leading by three.

### A finished game is judged on whether it mattered, not whether it was tense

Those are different questions, and the recap answered the second by default because a final is
graded on closeness. UMass beating Rutgers as 29.5-point underdogs scored **23.1**: the biggest
result of the weekend, sorted to the bottom of the list people read to find out what they missed.

So an upset can carry a finished game the way closeness carries a live one, capped below what a
real classic scores so the best finish still leads. That single change reorders the recap into
something worth scanning:

```
80.6  WMU @ MICH    12-13   MICH -27.5   INSTANT CLASSIC, ONE SCORE FINISH
71.7  CIT @ CLT     43-41   CLT -20.5    OVERTIME, BIG UPSET
64.1  MASS @ RUTG   37-21   RUTG -29.5   BIG UPSET      (was 23.1)
60.9  OKST @ TLSA   10-24   OKST -13.5   BIG UPSET
```

Two supporting changes. Finished games get `UPSET` and `BIG UPSET` rather than `UPSET ALERT`,
because an alert tells you to go and watch something that is already over. And the closing line is
backfilled for finished games, not only live ones: a game that started and ended between two polls
was never seen live, so the recap had no line to judge the result against.

### Concurrency changes the wording, not the decision

How many other games are live is a good measure of how valuable a notification is: the Michigan
alert fired with 19 other games running, which is exactly the "you are watching the wrong game"
case. It was tempting to make it a gate, and that was wrong. Two of the NFL alerts fired with
nothing else live, one of them a game that peaked at 86, and suppressing that assumes the viewer
is already watching something. They might simply have forgotten it was on. So the count picks the
phrasing instead: "Switch to X" when there are alternatives, "X is worth putting on" when there
are not.

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
- **Records have to be invented too, and plausibly.** In week one every team is 0-0, and a board
  full of `0-0` photographs as broken. But handing them out by position in the list produced a
  4-1 Titans and pushed Bills at Texans down the board. A reader does not know the records are
  props: they see the app rating a bad matchup over a good one and conclude it cannot judge
  football. NFL records now scale a published set of full-season predictions down to five games;
  college derives them from the AP rank already on the card, so a number one seed never appears
  at 3-2.
- **The drama has to land on a game that deserves it.** Situations are assigned in order and the
  first is a one-score game inside two minutes, which tops the board whatever it is attached to.
  Attached to the tightest line on the slate it gave a hero card of 1-4 Jets at 2-3 Titans:
  correct by the model, and a poor advertisement for it. The pool is ordered by matchup quality
  first, so the hero is a game a reader would agree earned it.

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
