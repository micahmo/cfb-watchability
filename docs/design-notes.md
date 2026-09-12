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
market had SMU as a **3-point favorite**, so a tie was the expected result. Rank gap cannot
tell a 3-point coin flip from a mismatch, and it rated Michigan, who were **27.5-point
favorites**, identically.

The fix is the **pregame closing line**, and no second data provider is needed. ESPN keeps it
in `pickcenter` on the summary endpoint, and it survives kickoff and the final whistle. Lines
are captured from the scoreboard while a game is still pregame; a game already live when the
process starts gets one `summary?event=<id>` lookup, cached permanently, since a closing line
never changes.

```
expectedDeficit = |spread| * progress
market = clamp((expectedDeficit - actualDeficit) / 21) * (0.4 + 0.6 * progress)
upset  = line ? max(market, 0.6 * rankUpset) : rankUpset
```

### The line decides when there is one, and rank only stands in when there is not

`combinedUpset` took the higher of the market reading and the rank reading, which let the cruder
signal override the better-informed one. Unranked Michigan leading eleventh-ranked Oklahoma 7-0 in
the second quarter rated **0.26** on the closing line, correctly unremarkable for a 5.5-point
underdog, and **0.61** on rank alone, which knows only "unranked versus eleventh". Even at the sixty
per cent ceiling that cleared the alert bar, so a game the market had called nearly even announced
itself as an upset.

Rank is already inside the line. A poll gap the market has priced at five and a half points is not a
surprise waiting to happen, it is a poll lagging, and consulting rank after the line has spoken
counts the same fact twice. So the line decides where it exists and rank stands in only where it
does not, which is what the market section above already claimed was the point of using it.

### The weight belongs on improbability, not on elapsed time

Even with the line deciding, alerts still fired in the first half of games that were merely going
the underdog's way. The lateness weight had a floor of 0.4, so a lead was worth nearly half its
eventual credit from the opening snap.

The floor is now 0.15 and `MAX_VS_LINE` tightened from 21 to 17. The two move together and the net
effect is to shift weight off *how long* a team has been ahead and onto *how improbable* it is that
they are. Measured on a live slate:

| | before | after |
| --- | --- | --- |
| 6.5-point dog up 10, second quarter | 0.37 alert | 0.34 quiet |
| 5.5-point dog up 7, second quarter | 0.36 alert | 0.23 quiet |
| 28.5-point dog up 6, second quarter | 0.54 alert | 0.49 alert |
| 24.5-point dog tied at half | 0.40 alert | 0.40 alert |

The 24.5-point one rising slightly while the 6.5-point one falls is the whole point: the surprise is
doing the work rather than the clock.

That reweighting only delayed the problem rather than fixing it. The 6.5-point game crossed the bar
again a few minutes later, because `vsLine` measures *points ahead of the line's pace*, and by that
measure a 6.5-point underdog leading by ten is twelve points ahead of expectation while a
twenty-point underdog **tied** is only eight. The coin flip reads as the bigger surprise, which is
backwards for a label meaning "something unlikely is happening".

So the tag needs a real underdog, at ten points or more, whatever the score is doing. A 6.5-point
dog leading is not unlikely, it happens every week, and you can only upset somebody who was actually
favoured. The notification path has always had this floor, at six, in `upsetTensionScore`; the tag
had none, which is why the board and the alerts disagreed about what counted. Reasoned rather than
measured, unlike the shootout thresholds: closing lines vanish from the scoreboard at kickoff, so
checking it against a season of finals would need a summary fetch per game. **Fitted to five live games, though**, which is a handful and
not a calibration set. The direction is principled and the constants are not yet earned; they want
checking against a season of in-game states the way the shootout thresholds were.

### The expectation has to be pro-rated, or every game opens as an upset

`expectedDeficit` started as the whole spread, compared against the score as it stood. That makes
a big underdog maximally surprising before anything has happened, because at 0-0 they are, by
construction, the full spread ahead of it. Norfolk State at Virginia, 46.5-point underdogs, scored
0.46 at 0-0 five minutes into the first quarter and carried an `UPSET ALERT` on the live board.
The same flaw ran the other way too: Norfolk State scored 0.50 while **losing 14-0**, which is the
single most expected thing that could have happened.

A spread is a full-game prediction, so the honest comparison is against how much of it should have
been delivered by now. Pro-rating by `progress` does that, and it matches what a viewer feels:
being level is remarkable in proportion to how long you have managed it.

The lateness factor stays on top of the pro-rating rather than replacing it, so the same gap earns
more as the game runs out of time to correct itself. Keeping both is also what preserves the
genuinely early upset, which a simple "not before the fourth quarter" gate would have destroyed:

| Situation, 46.5-point underdog | progress | upset | tagged |
| --- | --- | --- | --- |
| 0-0 at kickoff | 0.02 | 0.02 | no |
| 3-3 in the first | 0.12 | 0.13 | no |
| 3-3 at the end of the first | 0.25 | 0.30 | no |
| 3-3 at half | 0.50 | 0.70 | yes |
| **underdog up 14-0 in the first** | 0.15 | 0.49 | **yes** |
| underdog within 3 late | 0.92 | 0.95 | yes |

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

The **display** had no such fallback, so the probability bar, possession, down and distance and the
last play all vanished together and came back. The push feed is what made that obvious: a
thirty-second poll only sometimes landed inside a gap, while the stream shows every removal the
instant it happens. So the last situation is held and filled back in, with three rules that keep it
from inventing anything.

It only fills when the **whole** block is gone. Down and distance alone going absent is ordinary
football, between possessions or on a kickoff, and carrying "3rd & 6" across a punt would state
something false; a win probability or a last play still being there is what says the block is
present and the missing down is real. It expires after four minutes, because a probability from
that long ago is no longer about this game. And it is dropped the instant the score changes, since
a touchdown moves the probability, flips possession, resets the down and makes the last play the
scoring play, so everything held goes stale together.

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

### `SHOOTOUT` was a fourth instance, and the bug has a shape

It fired on a 21-31 college game, which is neither close enough nor high-scoring enough, and it
was wrong on both halves for different reasons.

**Not close enough.** The gate was `margin <= 10`, while the same function uses 8 everywhere else
it asks whether a game is close: `ONE SCORE FINISH`, `ONE SCORE, LATE`, `UPSET POTENTIAL` and the
clutch term all say one score is a touchdown and two. Ten admits a two-score game. There was no
recorded reason for the difference; it now shares the `ONE_SCORE` constant with the rest.

**Not high-scoring enough.** The gate was `totalPoints >= 52` in college, against a median expected
total of 54.5 on a live board and a modelled typical of 55. The bar sat *below* average, so an
ordinary game earned the tag by finishing. Across 315 finished college games it fired on 14.3%,
one game in seven, on results like 31-21, 30-24 and 24-31.

**The shape is the thing to remember**, because it is the same bug as the 0-0 upset alert fixed the
same day: a raw accumulating quantity compared against a full-game constant. Points only ever go up,
so a fixed bar is guaranteed to be crossed given enough game, and "enough game" arrives in every
game. Auditing the rest of the tags for it found no others, and the reason is a useful test:
`margin` moves in both directions, ranks and periods are facts, and every other gate reads a
normalised term off the breakdown. `totalPoints` was the only raw accumulating value in a gate.

The fix compares against the **projected** total, which blends the pregame expectation with what has
actually happened, weighted by how much game has been played. A finished game is simply its own
final score, and a game that has put up 52 points by halftime projects past a hundred and is a
shootout on the spot, which is the case the old absolute rule and a naive "raise the number" fix
both get wrong.

Reusing the existing `pace` term was the obvious move and it does not work, for a reason worth
recording: `pace` clamps, and the clamp destroys exactly the information needed here. The NFL scale
saturates at a projected 54 points, and 15% of NFL games are one-score games above that, so *no*
threshold on the clamped value can be more selective than 15% in that league. College saturates at
70, where the floor is 6%. So the tag reads the unclamped projection and `paceScore` is now a thin
wrapper over it.

Both thresholds are percentiles rather than opinions, chosen so the tag means the same thing in each
league, roughly the top 7% of games counting only one-score ones. Against 315 finished college games
and a full NFL season of 256:

| | before | after |
| --- | --- | --- |
| college | 14.3% | 7.3% |
| NFL | 26.7% | 6.6% |

The leagues need different numbers for the obvious reason: 61 points is a shootout in one and a
Tuesday in the other. The first NFL pass used 60 games from five Sundays, which is 1.7% per game and
far too coarse to calibrate a percentage point on; the full season moved the answer enough to matter.

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
since planning an evening around a mismatch is a bad idea however good the favorite is.
`prominence` takes the **better**, since one blue blood is enough to put a game in the national
conversation. Broadcast slot feeds prominence too: networks allocate their best inventory to the
games they expect to draw, so ABC and NBC rate far above ESPN+.

The list is grouped by day, days in chronological order, ranked within each day. You plan Friday
before you plan Saturday, so a better Saturday game must never outrank an earlier day's.
Grouping happens on the client so day boundaries land in the viewer's timezone.

### The cap has to be per day, not per slate

A single cap over the whole window, filled by anticipation, quietly guts the near term, and the
failure is invisible because what is missing was never drawn. Over an eight-day college window
ESPN returns around 157 upcoming games. Ranking all of them together and keeping 60 let next
Saturday decide this Saturday's list: week 4 conference play outranks week 3's non-conference
schedule, so a live board showed 39 games for next Saturday and 17 of tomorrow's 80. Three games
kicked off that had never appeared in the planning list at all, and the symptom reported was "I
have seen two games for today all week".

Capping within each day fixes it, and the number is deliberately set above the biggest real
Saturday so that in a normal week it never binds and nothing is dropped: it bounds a pathological
response rather than making a ranking decision. Only the next few days are shipped at all, since
the client renders three and the old list spent most of its budget on days it discarded without
drawing.

The day boundary used for the cap is the server's, and the one used for grouping is the viewer's.
They agree whenever the two share a timezone; where they do not, a game near midnight counts
against the neighbouring day's budget, which at this size trims nothing.

## The live list has to fold

Every live game renders, and nothing capped that. Measured on a 375-wide phone, a live card is
196px and an upcoming row is 57px, so the two lists scale very differently. Tomorrow's college
schedule has 80 games; assuming three and a half hours each, peak concurrency is 32 at around 9pm.
That is 6,272px of live cards, nearly eight phone screens, before the planning list even starts.

So the live cards fold. Folded is 80 to 100px depending on how many tags a game carries, and only
six show before an expander, the same number a day of the planning list shows and for the same
reason: the list is ranked, so the tail is the part nobody would switch to.

What stays visible when folded is the part that decides whether to look closer: teams, records,
the closing line, possession, score, the tags, and the clock. **The clock is the argument.** Close
and late is the question this board answers and lateness is the dominant term in the rating, so a
folded card reading 24-21 with no quarter on it has hidden the thing that makes 24-21 interesting.
It rides in the rating column under the number, which is empty space next to a two-row team block,
so it costs width rather than height. "Not on your channels" survives folding too, since it decides
whether the game is a candidate at all.

Opening one adds the win probability bar, the down and distance, the last play, the network and
the conference note.

The hero starts open, but it folds like the rest. Starting open is a default, not a restriction, and
conflating the two produced a card that looked identical to every other card and ignored a tap.

Finished games do not fold at all. Everything folding hides is live-only: the win probability, the
clock line and the last play are all gated on a game being in progress, so a folded final toggled
the network chip and nothing else, which is a pointless interaction for about thirty pixels. They
keep the per-list cap instead, which is where their vertical space actually was, and the client used
to slice that list to five while the server sent twelve, leaving seven unreachable.

The network never folds either, on any card. Where to watch a game is not the bulky part, and hiding
it is exactly backwards on the card you are deciding whether to switch to. It costs a wrapped tag row
on a card carrying two long tags, which is the right trade.

## A game that has not started is not a close game

ESPN moves a game out of `pre` before a snap is played, for a weather delay or a long pregame, and
such a game reads 0-0 in period 0. Left in the live list it does not merely appear, it **leads**:
scoreless is maximally close, so it scores `tension` 1.00. Seen live on a Saturday, a delayed
Oregon game sat at the top of the board as the best thing on, recommending a game where the ball
had not been kicked.

So a period, not a state, is the evidence that football has been played. Games in `in` with period
0 are folded into the planning list instead, since "has not kicked off yet" is exactly what they
are, and dropping them would make a delayed game vanish from the board altogether. The row says
`Delayed` rather than a kickoff time that is no longer going to happen.

This is the third instance in two days of the same family, and the family is worth naming: **a
quantity that starts at its most extreme value and only becomes meaningful once play begins.** A
0-0 game is perfectly close. A 46.5-point underdog is perfectly ahead of the spread before kickoff.
Points scored start below any absolute bar and cross it simply by the game continuing. Each one
needed the same correction, which is to measure against how much game has actually happened.

## Kickoff alerts fire on the kick, not the clock

The alert used to fire when the scheduled time passed. A listed kickoff is when the television
window opens and the ball goes up five to ten minutes later, so the notification arrived while the
board still showed nothing live and every game in the window still read as upcoming. Reported from
both ends on the same afternoon: a kickoff alert for a game that had not started.

It now waits for the chosen game to actually be in progress, which is a transition like every other
alert in this file rather than a timestamp. Two details make that work. The window is grouped from
live and upcoming together, because a window empties as its games kick off, and grouping only what
is still pregame would shrink a twelve-game noon slate down until the last straggler looked like a
window with one game in it, which is the exact condition the primetime alert fires on. And
anticipation is remembered per game as snapshots go by, because a game drops its pregame rating the
moment it starts, and without the memo the game that just kicked off would rank last in its own
window.

The grace period grew from five minutes to two hours for the same reason: the trigger is the kick,
a delay can push that back a long way, and the bound now exists only so a game postponed to another
day does not announce itself when it eventually starts.

### Widening the window re-opened a hole the old one closed by accident

A restart mid-afternoon then announced a window whose games had kicked off before the process
started. Seen live: a kickoff alert nine minutes into the first quarter, reading "rated 13, not
expected to be much" about a marquee game. Two symptoms, one cause. The process had never seen those
games pregame, so the anticipation memo was empty and the rating collapsed to the favourite bonus
alone, which is 13 for two favoured conferences; and kickoff windows were never seeded, so the
window looked unannounced.

The seeding block already existed and its own comment said a Force Update mid-Saturday must not
re-announce the afternoon. It seeded `hero`, `classic` and `upset`. Kickoff did not need it while
the trigger was a five-minute clock window, because a restart could not land inside one. Moving to a
two-hour state window silently removed that protection. Live games now seed their windows too, and a
game this process never saw pregame is never announced at all, so a rating nobody can vouch for
cannot be sent.

### Ranking and display are different jobs

The first attempt at the rating fixed it by clamping inside the ranking function, which is where the
board clamps. That made the two best games in a window tie at the ceiling, and a stable sort handed
the window to whichever came first, which was one that had not kicked off yet, so the window went
unannounced entirely. The clamp belongs only where a person reads the number.

The wording moved with it. Every other alert says "rated", meaning the live score. Before kickoff
the number is an expectation, and calling both "rated" is what made the notification and the board
look like they disagreed when the board had simply switched that game to its live rating the moment
it started.

## A faster feed changed what an old metric meant

`RECENT SWINGS` appeared on two 0-0 games at once. The tag reads `swing`, which was the **cumulative
sum** of absolute win-probability change across a fifteen-minute window, and a sum over samples
depends on how often you sample. That had been a constant at one poll every thirty seconds. The push
feed made it as often as once a second.

The evidence was two servers watching the same two games at the same moment: one running forty
minutes scored them 0.81 and 0.97 and tagged both, one running five minutes scored the same games
0.06 and 0.12. Neither had a point on the board.

It also measured the wrong thing even at a fixed rate. A close game's win probability wanders a
little every play and those wanders accumulate, while a blowout's sits pinned and still, so a 0-13
game scored zero while 0-0 games topped the list. That is `tension` wearing a different hat, and
`tension` is already a term.

So `swing` is now the **range**, high-water to low-water, inside the window. A range cannot be
inflated by looking more often, it ignores wandering that returns to where it started, and it still
catches a game that changes hands. Verified against a synthetic close game at both sampling rates:
0.158 at thirty samples and 0.160 at three hundred, where the sum gave answers an order of magnitude
apart. A genuine 40% to 80% move scores 0.80 and still tags.

**The general lesson is about what a faster feed silently changes.** Nothing about the swing code was
wrong when it was written; its meaning depended on a cadence that quietly stopped holding. Auditing
the rest of the server for the same shape found no other metric that accumulates across observations:
everything else either recomputes from current state or counts within a single pass. It did turn up
a different fault in the same commit, enrichment fired and forgotten on the push path, where it
resolved after the snapshot had already been published and so never landed at all. Normalising builds
fresh objects each rebuild, so nothing carried over, and every push-driven NFL rebuild lost its
divisions, playoff seeds and standings win percentage until the next poll repaired it.

## The field diagram, and the coordinate system nobody documents

The rating cannot say what is happening. Fourth and one at the goal line and second and ten at
midfield can score identically, so an expanded card draws the field: ball, line of scrimmage, line
to gain, the drive so far, and which way the offence is going.

**`situation.yardLine` is yards from the *home* team's goal line, nought to a hundred**, whoever has
the ball. That is not self-evident and it was verified against nine live games rather than assumed,
by parsing ESPN's own prose and checking it predicted the number: "1st & 10 at PSU 42" with Temple
at home reports 58, "2nd & 10 at MICH 35" with Michigan at home reports 35. Nine of nine. Direction
follows from possession, home attacking a hundred and away attacking nought, and the line to gain is
the ball give or take the distance by that direction.

`situation.lastPlay.drive.start.yardLine` is in the same space, so the arrow spans the drive rather
than pointing vaguely downfield, and its length is the ground gained. That was checked the same way:
a drive starting at "OU 25" (75) with the ball at "MICH 29" (29) is 46 yards, and the description
reads "6 plays, 46 yards".

Four things it refuses to draw, all the same principle, that a picture which states something false
is worse than no picture:

- **Nothing without the whole situation.** `down`, `distance` and `yardLine` all go missing between
  plays, on kickoffs and through the gaps where ESPN drops the block entirely. No data, no field.
- **No line to gain on first and goal.** The distance overshoots the goal line, and a marker beyond
  the end zone is a line that does not exist.
- **No drive arrow when the drive contradicts the ball.** `lastPlay.drive` still describes the
  previous possession for a moment after a turnover, which would draw an arrow running backwards
  through the ball. Seen immediately: a team attacking nought reported a drive starting at nought.
  When the start is not behind the ball, it falls back to a stub showing direction only.
- **No field-goal range.** It is not derivable and would be invention.

Yard numbers sit every ten, as a real field is painted, minus whichever ones the two lines are
standing on. Every twenty was tried first and read as a fault rather than a choice: with the forty
and the fifty both suppressed the row jumped from 40 to 20, where a 30 and a 10 would have fitted.

It updates from the push feed like everything else, which was measured rather than assumed: ball
movements arrive on push frames, never waiting for a poll.

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
teams, because planning an evening around a mismatch is a bad idea however good the favorite is.
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

The conference-favorite bonus is graded rather than binary: both teams, then one, then neither.
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
| Primetime | The only game in its window, NFL only | At kickoff |

**Primetime is the exact inverse of kickoff**, so the two can never both fire. Kickoff says "this
is the pick of a crowded slate"; primetime says "there is nothing to choose between, but football
is on". No clock heuristic and no hardcoded slots are needed, because "the only game in its
window" finds Thursday, Sunday and Monday night on a normal week and, on a holiday week, also
finds the Thanksgiving afternoon games and Black Friday. An after-7pm rule would have missed
exactly those, and they are the ones most worth knowing about. Measured: three solo windows in a
normal week, eight in Thanksgiving week.

Both kickoff alerts carry how good the game is expected to be, in words and as the rating. That
matters most for primetime, whose premise is that the only game on might be a bad one; saying
"Not expected to be much" is the honest version of the alert rather than a failure of it.

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

Note the first quarter: level at 7-7 against a 29.5-point favorite scores almost nothing, and
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

### Telling a dead subscription from a living one

Reinstalling the app orphans a subscription, and nothing in the obvious places notices. The
reinstall is a fresh service worker with a new endpoint, the old record survives because the
browser does not reliably unsubscribe on uninstall, and the push service keeps returning success
for the dead endpoint rather than the 410 that `send` watches for. Deduplicating at subscribe time
cannot help either, because the new install has no memory of the endpoint it replaced, so the
server cannot know which record the new one supersedes.

Nor can staleness be keyed on the viewer opening the board. Somebody can turn alerts on and then
never open it again, so "has not loaded lately" describes a satisfied user, not a dead
subscription.

The one thing that tracks the subscription rather than the person is the service worker, which
runs on push receipt whether or not the app is open. So it acknowledges: every push it shows, it
posts its endpoint back, anonymously and keyed on the endpoint, because the worker has no session
to present and the endpoint is already the subscription's secret. Two timestamps record the two
sides. `lastPushAt` moves when a push service accepts a message; `lastAckAt` moves when a worker
says it arrived. A living install keeps them level and a dead one lets the first pull ahead.

The gap, never the wall clock, is what the prune acts on, and that is what keeps a quiet stretch
safe: a subscription nobody had reason to push to accrues no gap however old its last
acknowledgement, and a phone that was merely asleep closes the gap as soon as it answers the queued
push. Thirty days is generous on purpose. Catching orphans is easy, since their gap grows without
bound; the number has to clear the other direction, the longest a real phone can go unacknowledged
across sleep, dead zones and iOS throttling.

### The board re-registers itself, which is what makes the rest safe

Registering only when a category is toggled left two silent failures, and the prune would have
made the first one worse.

A subscription could die and stay dead. Push services rotate endpoints, and the only cure was
toggling a category off and on, which nobody knows to do. And anything learned *after* subscribing
never arrived: the market resolves from a snapshot, so subscribing from the college tab registered
no market at all and the promise that alerts skip games you cannot watch was doing nothing; a
changed favorite conference moved the board's own ranking without reaching the alerts that use the
same boost.

Re-registering whenever any of those inputs change covers all of it, and repairs the endpoint on
the way past. It never prompts: permission already being granted is what makes it a repair rather
than a request. Two details matter. The explicit toggle stays authoritative and records what it
sent, so the background sync does not repeat it, and a burst of changes is debounced, so ticking
four conferences is one update. And a re-registration carrying no market must not erase a known
one, since the zip is null until a snapshot resolves one, which on the college tab may be never.

## Telling an open board that it is out of date

The service worker cannot do it. `sw.js` is copied into the build untouched and names no hashed
bundles, so it is byte identical between deploys and `updatefound` never fires.

Three approaches, in the order they were tried:

1. **Re-fetch `index.html` on a timer** and compare the script tag. Works, but is exactly as slow
   as the interval, and five minutes is a long time to sit looking at a stale board.
2. **Check when a poll fails and then recovers**, on the theory that a restart means a deploy.
   This shipped and was wrong. It was lifted from an app with a persistent event stream, where a
   dropped connection genuinely is unambiguous evidence of a restart. Polling has no equivalent: a
   container that comes back between two twenty-second polls produces no error at all, so the
   check never runs. The symptom was precise and it is worth remembering as a diagnostic: the user
   never saw the "offline" indicator during the update, which is the same thing as saying the
   trigger never fired.
3. **The server reports the bundle it is serving** on every snapshot. The board already asks for
   one every twenty seconds, so a deploy is noticed on the next poll, with no extra request, no
   timer, and no dependence on anything having failed.

The general lesson is about porting: the mechanism moved across cleanly but its *precondition* did
not, and nothing complained. A trigger that relies on an outage is only reliable where an outage
is guaranteed.

## ESPN has a push feed, and it is reachable

There are no webhooks, but ESPN runs **FastCast**, the websocket service its own site uses for
live scores. It is undocumented, like every other endpoint this project uses, and it works:

```
1. GET  https://fastcast.semfs.engsvc.go.com/public/websockethost
        -> {"ip": "pe<uuid>-<ip>.fastcast.semfs.engsvc.go.com", "securePort": 9573, "token": "..."}
2. WS   wss://{ip}:{securePort}/FastcastService/pubsub/profiles/12000?TrafficManager-Token={token}
3. send {"op":"C"}                                     -> {"rc":200,"hbi":30,"sid":"..."}
4. send {"op":"S","sid":sid,"tc":"scoreboard-football-nfl"}  -> {"rc":200}
5. receive {"op":"P","tc":...,"pl":...} pushes; {"op":"B"} is the heartbeat
```

Two details cost time. Node's built-in `WebSocket` fails the upgrade; a manual handshake over
`https.request` succeeds, with or without an `Origin` header. And the path is right even when it
returns 404 to a plain GET: `{"rc":404,"op":"ERROR"}` with a `Server: Fastcast/4.1.26` header is
the service saying "that was not an upgrade request", whereas an unrecognized path returns an
empty 404. That distinction is what located the correct path.

Valid topic found: `scoreboard-football-nfl`. Per-event names of the shape `gp-football-nfl-<id>`
and `event-<id>` are all rejected, so the scoreboard topic appears to be the unit.

**The payload is RFC 6902 JSON Patch**, captured live against women's college volleyball:

```
{"op":"P","mid":1978179,"tc":"scoreboard-...","pl":"{\"ts\":...,\"~c\":1,\"pl\":\"eJyLrlbK...\"}"}
```

`pl` is a JSON string whose own `pl` field is base64 zlib. Inflated:

```json
[{"op":"replace",
  "path":"s:400~l:402~e:401897757/competitions/0/competitors/1/linescores/0/value",
  "value":23}]
```

Two layers of `pl` is the trap: base64-decoding the outer one yields noise, which looks like an
unknown compression format and sent the first attempt down the wrong path entirely.

Deltas, roughly 230 bytes each, keyed by ESPN's `s:<sport>~l:<league>~e:<event>` uid, with paths
that land directly on the scoreboard document the REST client already parses. Measured 13 pushes
in 35 seconds across a dozen live matches.

That makes the shape obvious, and it is what ESPN's own site does: fetch the scoreboard once for
initial state, subscribe, apply patches, re-score. It would take the live board from roughly fifty
seconds stale to a couple of seconds.

Now built, together with SSE, because either both or neither. The chain is: a patch arrives, it is
applied to ESPN's own document, that document is re-normalised and re-scored, and the new board is
pushed to every open client.

**The raw document had to be kept.** `fetchScoreboard` normalised and threw ESPN's structure away,
and patch paths address fields inside exactly that structure, so there was nothing to apply a delta
to. The poller now holds the events by uid and re-normalises after each burst, which also means a
pushed update is scored by the same code as a polled one rather than by a parallel path that could
drift.

**Bursts are coalesced.** A single play produces a dozen patches as the clock, score, drive and
situation update in turn, and rebuilding on each would re-score the slate a dozen times to reach the
same answer. One second of gathering collapses that, and is still an order of magnitude fresher than
the poll it sits on top of.

**Polling stays, and is the floor.** REST still owns odds, standings and the schedule, none of which
come down this feed, and it repairs anything a dropped stream missed. Every reconnection forces a
resync for that reason: a patch carries only the field that changed, so a gap leaves the held
document wrong in ways no later patch corrects. That resync is skipped while a poll is already in
flight, since at startup the socket connects mid-poll and both would fetch the same slate.

Measured on a quiet night: `push(5)` and `push(1)` rebuilds arriving between polls, and a client
holding a stream open received four boards in a hundred seconds, two of them seven seconds apart.

### A push must not carry the whole board

The first version sent the entire snapshot on every push, which measured 223KB, of which 215KB was
the planning list. Seventy-five seconds of watching a board with nothing live cost 900KB, and the
ceiling with a full slate and a one-second window was around 13MB per client per minute. That is a
lot of bytes to move eight kilobytes of scores.

So a push leaves the planning list out when it has not changed, and the client keeps the one it
already has. It is compared rather than assumed, which matters: when a game kicks off it leaves the
list, the comparison fails, and the new list goes out. Omitting it blindly would have shown that game
as live and upcoming at once until the next poll. The field is omitted rather than emptied, since an
empty array would read as "every upcoming game is gone".

Measured after: 120KB on connect, 8KB per push, and a frame in between that correctly resent the list
at 223KB when the schedule poll grew it from 80 games to 155.

The coalescing window stayed at one second. The bandwidth problem was caused by sending the wrong
data, not by sending it too often, and making every viewer's board staler would have been treating
the symptom. If volume is still a problem on a full slate, the next lever is sending only the games
that changed, not slowing down the ones that did.

### What the numbers actually are

The client polled every 20 seconds and the server every 30, so worst case a score was 50 seconds old.
FastCast alone would have made the server fresh within a second while leaving the client's 20-second
poll as the new ceiling, which is why it was never worth building on its own. With both, a play
reaches an open board in about a second.

The stream carries the build id exactly as a poll does, so the update prompt keeps working off a
direct comparison rather than off a reconnection. Who's Home does the same thing in the other
direction: it treats a reconnect purely as a cue to re-run its bundle check, never as the answer.
A reconnect is evidence of a restart, not proof of a deploy, and a sleeping phone produces one
without anything having shipped.

### What a second capture, against live football, added

Three things the first pass had wrong or had not seen.

**`op:"R"` carries patches too, not just `op:"P"`.** Decoding only `P` made the feed look like it
had gone silent after an opening burst while updates were in fact still arriving.

**The inner `~c` field says how the payload is encoded.** `1` is the base64 zlib described above;
`0` means `pl` is already the patch array as plain JSON. Assuming compression throws on every
uncompressed message.

**Unanswered websocket pings are what actually kills the session.** These are protocol-level ping
frames, not the application `op:"B"` heartbeat, and they are easy to miss because a JSON parser
skips them silently as unparseable. Without pongs the feed stopped after about two minutes and
looked like a quiet topic; with them it ran continuously, roughly 130 patches a minute across
three or four live games, answering about six pings a minute.

The payload is what the board needs: `status/clock`, `status/period`, `competitors/N/score`,
`linescores`, and the whole `situation` block including possession and down and distance. So the
feed is confirmed usable for college as well as the NFL. Volume against a full Saturday slate is
still unmeasured, and that is the open question before building on it.

This also settles the SSE question, which was previously "no". That answer assumed the server
stays 30 seconds behind ESPN, which makes pushing to the client pointless. The two go together:
FastCast without SSE mostly wastes the freshness, and SSE without FastCast is a 20-second
improvement on a 50-second problem. Either both, or neither.

## Regenerating the screenshots

The README shows four panels: live and upcoming, for each league. Only the upcoming pair can be
photographed from the real board, because a live board only exists while games are being played,
and waiting for a Sunday to document a UI change is not a workflow. The alternative, shipping
stale images, is what actually happened: the original pair went three features out of date before
anyone noticed, still showing a college-only app with no league tabs, favorites or market
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
