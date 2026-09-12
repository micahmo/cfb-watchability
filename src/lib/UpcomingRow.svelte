<script lang="ts">
  import type { Game } from "../../shared/types";
  import { kickoffTime, scoreColor, teamColor } from "./format";

  let { game, score, now = Date.now() }: { game: Game; score?: number; now?: number } = $props();

  /*
   * What the time column says when the scheduled time has gone by.
   *
   * A listed kickoff is when the television window opens, and the ball goes up
   * five to ten minutes later, so a row can sit in the planning list showing a
   * time that has already passed with nothing to say it is under way. That is
   * what made a kickoff notification look wrong: the alert said the window had
   * started and thirteen games still read as upcoming at 12:00. `Delayed` is the
   * other case, a game ESPN has moved out of `pre` without a snap being played.
   */
  const when = $derived(
    game.state === "in"
      ? "Delayed"
      : Date.parse(game.startDate) <= now
        ? "Now"
        : kickoffTime(game.startDate),
  );
  const imminent = $derived(when !== kickoffTime(game.startDate));

  const shown = $derived(score ?? game.anticipation ?? 0);

  const unavailable = $derived(game.marketStations !== null && game.marketStations.length === 0);

  const accent = $derived(scoreColor(shown));
</script>

<div class="row" class:unavailable>
  <div class="score mono" style="color: {accent}">{Math.round(shown)}</div>
  <div class="when mono">
    <span class="time" class:imminent>{when}</span>
  </div>
  <div class="matchup">
    <span class="teams">
      {#each [game.away, game.home] as team, i (team.id)}
        {#if i === 1}<span class="at">at</span>{/if}
        <span class="team">
          {#if team.logo}
            <img class="logo" src={team.logo} alt="" loading="lazy" />
          {:else}
            <span class="logo placeholder" style="background: {teamColor(team)}"></span>
          {/if}
          {#if team.rank}<span class="rk mono">{team.rank}</span>{/if}
          <span class="team-name">{team.name}</span>
        </span>
      {/each}
    </span>
    <span class="line mono">
      {#if game.broadcast}<span class="channel-chip">{game.broadcast}</span>{/if}
      {#if game.odds}<span>{game.odds}</span>{/if}
      {#if game.overUnder}<span>o/u {game.overUnder}</span>{/if}
      {#if !game.nationalBroadcast}<span class="local">local feed</span>{/if}
    </span>
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .row:last-child {
    border-bottom: none;
  }
  .score {
    flex: none;
    width: 30px;
    text-align: right;
    font-size: 17px;
    font-weight: 700;
  }
  .when {
    flex: none;
    /* Wide enough for a two-digit hour ("12:00 PM") without wrapping, and fixed
       so kickoff times stay aligned down the column. */
    width: 72px;
    white-space: nowrap;
  }
  .time {
    color: var(--text);
    font-weight: 600;
  }
  /* Warm rather than loud. It is a correction to a stale clock, not an alarm. */
  .time.imminent {
    color: var(--warm);
    font-size: 11px;
  }
  .matchup {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .teams {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }
  .team {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .team-name {
    white-space: nowrap;
    /* Only bites on genuinely narrow windows, and degrades to an ellipsis rather
       than a hard clip when it does. */
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .logo {
    width: 17px;
    height: 17px;
    object-fit: contain;
    flex: none;
  }
  .logo.placeholder {
    border-radius: 50%;
  }
  .at {
    color: var(--text-faint);
    font-size: 11px;
    flex: none;
  }
  .rk {
    color: var(--warm);
    font-size: 10px;
    font-weight: 700;
    flex: none;
  }
  .line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
    font-size: 11px;
    color: var(--text-faint);
    margin-top: 2px;
  }
  .local {
    color: var(--warm);
  }
  .row.unavailable {
    opacity: 0.55;
  }
</style>
