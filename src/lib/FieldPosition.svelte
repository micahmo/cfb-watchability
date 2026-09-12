<script lang="ts">
  import type { Game } from "../../shared/types";
  import { teamColor } from "./format";

  let { game }: { game: Game } = $props();

  /*
   * Drawn only when the whole situation is there.
   *
   * `down`, `distance` and `yardLine` all go missing between plays, on kickoffs
   * and during the stretches when ESPN drops the situation block, and a field
   * showing the last known ball position as though it were current is a worse
   * answer than no field at all. Possession is required too: without it there is
   * no direction of play, and the arrow and the first-down line would both be
   * guesses.
   */
  const situation = $derived(
    game.state === "in" &&
      game.yardLine !== null &&
      game.down !== null &&
      game.distance !== null &&
      game.possessionTeamId !== null
      ? { yardLine: game.yardLine, down: game.down, distance: game.distance }
      : null,
  );

  const homeHasBall = $derived(game.possessionTeamId === game.home.id);
  /** Home defends the zero end, so it attacks 100 and the away team attacks zero. */
  const towardHundred = $derived(homeHasBall);

  const firstDown = $derived.by(() => {
    if (situation === null) return null;
    const raw = towardHundred
      ? situation.yardLine + situation.distance
      : situation.yardLine - situation.distance;
    // Clamped to the goal line: on first and goal the distance overshoots the
    // field, and a marker drawn past the end zone would be a line that does not
    // exist. Nothing is drawn at all once it lands on the goal line itself.
    const clamped = Math.max(0, Math.min(100, raw));
    return clamped <= 0 || clamped >= 100 ? null : clamped;
  });

  /**
   * The drive so far: from where it began to where the ball is now.
   *
   * More useful than a bare direction marker, because it says how far this
   * possession has already come. Guarded on consistency rather than trusted:
   * `lastPlay.drive` still describes the previous possession for a moment after a
   * turnover, which would draw an arrow running backwards through the ball. If the
   * start is not behind the ball relative to the way this team is attacking, or
   * the drive has not moved, it falls back to a short stub that only shows which
   * way play is going.
   */
  const drive = $derived.by(() => {
    if (situation === null || game.driveStart === null) return null;
    const from = game.driveStart;
    const to = situation.yardLine;
    const sane = towardHundred ? from < to : from > to;
    return sane ? from : null;
  });

  /* Geometry in user units: ten per end zone, a hundred of field between them. */
  const EZ = 10;
  const W = 100 + EZ * 2;
  const H = 24;
  const x = (yard: number) => EZ + yard;

  /**
   * The arrow, always behind the ball and pointing at it.
   *
   * Drawing the head *ahead* of the ball, which the no-drive fallback used to do,
   * put it in the end zone whenever the ball was near the goal line and, worse,
   * dropped it between the line of scrimmage and the line to gain, where it read as
   * a third marker rather than as direction. Behind the ball it can do neither: the
   * tip sits just off the ball and everything else trails away from the end zone
   * being attacked.
   */
  const GAP = 3.4;
  /* Sized for a filled triangle, which carries less visual weight than the stroked
     chevron it replaced, so the same numbers came out looking tiny. Length a little
     over one and a half times the half-height reads as an arrowhead rather than a
     dot; taller than this and it was the original complaint again. */
  const HEAD_LEN = 3.2;
  const HEAD_HALF = 2;
  /**
   * Shortest line worth drawing, measured in the direction of play.
   *
   * Signed rather than absolute, which is the whole point. The head reserves
   * `GAP + HEAD_LEN` behind the ball, so on a drive shorter than that the head
   * lands *behind* its own start and the tail has to run backwards to reach it.
   * An absolute distance reads that as a perfectly good arrow: seen live, a
   * three-yard drive produced a tail of 3.6 units pointing the wrong way, drawn
   * underneath a head 3.2 long, which on a phone is a caret and no line at all.
   */
  const MIN_TAIL = 2.5;

  /**
   * Two rules, and the arrow is simply absent whenever either fails.
   *
   * It is drawn only when there is a real drive long enough to show as a line: a
   * bare caret floating beside the ball says nothing a reader can use, and every
   * attempt to place one sensibly ran into an end zone or a first-down line. And
   * nothing is ever clamped into position. Clamping produced marks that looked
   * deliberate while sitting somewhere the ball has not been, which is the same
   * fault as a stale field, so if the whole arrow does not fit on the grass there
   * is no arrow.
   */
  const arrow = $derived.by(() => {
    if (situation === null || drive === null) return null;
    const dir = towardHundred ? 1 : -1;
    const ball = x(situation.yardLine);
    const tip = ball - dir * GAP;
    const back = tip - dir * HEAD_LEN;
    const tail = x(drive);
    if ([tip, back, tail].some((at) => at < EZ || at > EZ + 100)) return null;
    if (dir * (back - tail) < MIN_TAIL) return null;
    return { dir, tip, back, tail };
  });

  /**
   * Yard numbers every ten, as a real field is painted, minus the ones the two
   * lines are standing on.
   *
   * Every twenty was tried first and read as a mistake rather than a choice: with
   * the forty and the fifty both suppressed the row jumped straight from 40 to 20
   * and looked like something had failed, when a 30 and a 10 would have sat there
   * perfectly well. At ten-yard spacing each line hides at most its nearest
   * neighbour, so the gap is small enough to read as deliberate.
   */
  const MARKS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const marks = $derived.by(() => {
    if (situation === null) return [];
    const clear = (yard: number) =>
      Math.abs(yard - situation.yardLine) > 6 && (firstDown === null || Math.abs(yard - firstDown) > 6);
    // Numbered from the nearer goal line, the way a real field is painted.
    return MARKS.filter(clear).map((yard) => ({ yard, label: yard <= 50 ? yard : 100 - yard }));
  });

  const homeColor = $derived(teamColor(game.home));
  const awayColor = $derived(teamColor(game.away));
</script>

{#if situation !== null}
  <svg class="field" viewBox="0 0 {W} {H}" role="img" aria-label={game.downDistance ?? "field position"}>
    <!-- Home defends the left end, always. A field that mirrored itself whenever
         possession changed would be unreadable at a glance, so the picture stays
         still and the arrow carries the direction instead. -->
    <rect x="0" y="0" width={EZ} height={H} fill={homeColor} opacity="0.85" />
    <rect x={EZ + 100} y="0" width={EZ} height={H} fill={awayColor} opacity="0.85" />
    <rect x={EZ} y="0" width="100" height={H} fill="var(--field)" />

    {#if game.isRedZone}
      <!-- The twenty the offence is attacking, not both. -->
      <rect
        x={towardHundred ? x(80) : x(0)}
        y="0"
        width="20"
        height={H}
        fill="var(--warm)"
        opacity="0.14"
      />
    {/if}

    {#each [10, 20, 30, 40, 50, 60, 70, 80, 90] as yard (yard)}
      <line x1={x(yard)} y1="0" x2={x(yard)} y2={H} class="yard" class:fifty={yard === 50} />
    {/each}

    {#each marks as mark (mark.yard)}
      <text class="yard-num" x={x(mark.yard)} y={H - 3.2}>{mark.label}</text>
    {/each}

    {#if firstDown !== null}
      <line x1={x(firstDown)} y1="0" x2={x(firstDown)} y2={H} class="first-down" />
    {/if}
    <line x1={x(situation.yardLine)} y1="0" x2={x(situation.yardLine)} y2={H} class="scrimmage" />

    <!-- Tail at the drive start where there is one, head always just behind the
         ball, so the length of the line is the ground this drive has made. -->
    {#if arrow !== null}
      <path class="arrow" d={`M ${arrow.tail} ${H / 2} H ${arrow.back}`} />
      <!-- Filled and closed, not an open chevron. Open, the line stopped at the
           mouth of the V and left a stroke-free gap along the middle to the point;
           overlapping them instead showed the line through the caret, since both
           are drawn semi-transparent. A solid triangle has a flat back edge for the
           line to meet, so there is neither gap nor show-through. -->
      <path
        class="arrow head"
        d={`M ${arrow.back} ${H / 2 - HEAD_HALF} L ${arrow.tip} ${H / 2} L ${arrow.back} ${H / 2 + HEAD_HALF} Z`}
      />
    {/if}

    <ellipse class="ball" cx={x(situation.yardLine)} cy={H / 2} rx="3" ry="1.9" />

    <text class="ez" x={EZ / 2} y={H / 2} transform="rotate(-90 {EZ / 2} {H / 2})">
      {game.home.abbrev}
    </text>
    <text class="ez" x={EZ + 100 + EZ / 2} y={H / 2} transform="rotate(90 {EZ + 100 + EZ / 2} {H / 2})">
      {game.away.abbrev}
    </text>
  </svg>
{/if}

<style>
  .field {
    display: block;
    width: 100%;
    height: auto;
    margin: 8px 0 2px;
    border-radius: 3px;
    overflow: hidden;
    /* Not a literal grass green. The card is dark and a saturated pitch would
       shout louder than the score it sits under. */
    --field: color-mix(in srgb, var(--bg-card-hi) 82%, #2f6f4a 18%);
  }
  .yard {
    stroke: var(--border-hi);
    stroke-width: 0.4;
    opacity: 0.5;
  }
  .fifty {
    opacity: 0.9;
  }
  /* Television convention, because it needs no explaining: the line to gain is
     yellow and the line of scrimmage is blue. */
  .first-down {
    stroke: #ffd34d;
    stroke-width: 1.1;
  }
  .scrimmage {
    stroke: #4da3ff;
    stroke-width: 1.1;
  }
  .ball {
    fill: #d8c59a;
    stroke: rgba(0, 0, 0, 0.55);
    stroke-width: 0.5;
  }
  /* One opacity for both halves. Two made the caret read as a lighter colour than
     the line it belongs to, as though it were a separate mark. */
  .arrow {
    fill: none;
    stroke: var(--text);
    stroke-width: 1;
    /* Butt, not round: a round cap overruns the join by half the stroke and
       double-darkens where it meets the head. */
    stroke-linecap: butt;
    stroke-linejoin: round;
    opacity: 0.6;
  }
  .arrow.head {
    fill: var(--text);
    stroke: none;
  }
  .yard-num {
    fill: var(--text-faint);
    font-size: 4.2px;
    font-weight: 600;
    text-anchor: middle;
    opacity: 0.85;
  }
  .ez {
    fill: #fff;
    font-size: 5.4px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-anchor: middle;
    dominant-baseline: central;
    paint-order: stroke;
    stroke: rgba(0, 0, 0, 0.35);
    stroke-width: 1.2;
  }
</style>
