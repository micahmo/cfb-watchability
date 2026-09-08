<script lang="ts">
  import type { TeamSide } from "../../shared/types";
  import { colorsTooSimilar, teamColor } from "./format";

  let { home, away, homeWinProb }: { home: TeamSide; away: TeamSide; homeWinProb: number } =
    $props();

  const awayColor = $derived(teamColor(away));
  const homeColor = $derived(teamColor(home));
  const awayPct = $derived((1 - homeWinProb) * 100);
  // When the two schools wear the same color, hatch one side so the split stays
  // readable without inventing a color neither team owns.
  const needsPattern = $derived(colorsTooSimilar(awayColor, homeColor));
</script>

<div class="track">
  <div class="bar">
    <div
      class="seg"
      class:hatched={needsPattern}
      style="width: {awayPct}%; background: {awayColor}"
    ></div>
    <div class="seg" style="width: {100 - awayPct}%; background: {homeColor}"></div>
  </div>
  <div class="handle" style="left: {awayPct}%"></div>
</div>

<div class="labels mono">
  <span class="side">
    <span class="swatch" class:hatched={needsPattern} style="background: {awayColor}"></span>
    {away.abbrev}
    <strong>{Math.round(awayPct)}%</strong>
  </span>
  <span class="side">
    <strong>{Math.round(100 - awayPct)}%</strong>
    {home.abbrev}
    <span class="swatch" style="background: {homeColor}"></span>
  </span>
</div>

<style>
  .track {
    position: relative;
    margin-top: 10px;
  }
  .bar {
    position: relative;
    display: flex;
    height: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--border);
  }
  .seg {
    transition: width 0.5s ease;
  }
  .seg.hatched {
    background-image: repeating-linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.42) 0 5px,
      rgba(0, 0, 0, 0) 5px 10px
    );
  }
  .handle {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 3px;
    border-radius: 2px;
    background: #fff;
    transform: translateX(-50%);
    box-shadow: 0 0 0 1.5px var(--bg-card), 0 0 6px rgba(0, 0, 0, 0.6);
    transition: left 0.5s ease;
  }
  .labels {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 6px;
  }
  .side {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .side strong {
    color: var(--text);
  }
  .swatch {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    border: 1px solid rgba(255, 255, 255, 0.25);
  }
  .swatch.hatched {
    background-image: repeating-linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.42) 0 3px,
      rgba(0, 0, 0, 0) 3px 6px
    );
  }
</style>
