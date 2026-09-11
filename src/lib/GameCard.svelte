<script lang="ts">
  import type { Game } from "../../shared/types";
  import { clockLabel, scoreColor, teamColor } from "./format";
  import WinProbBar from "./WinProbBar.svelte";

  let {
    game,
    score,
    variant = "live",
  }: {
    game: Game;
    score: number;
    variant?: "live" | "final";
  } = $props();

  const accent = $derived(scoreColor(score));
  const showWp = $derived(variant === "live" && game.score?.hasWinProb === true);
  // Dimming the team that is behind reads as "this one lost", which is only true
  // once the game is over. Mid-game both teams stay at full weight.
  const leader = $derived(
    variant !== "final" || game.home.score === game.away.score
      ? null
      : game.home.score > game.away.score
        ? "home"
        : "away",
  );
  const clockText = $derived(clockLabel(game));
  /** Null until a postal code is set, so absence means unknown, not unavailable. */
  const unavailable = $derived(game.marketStations !== null && game.marketStations.length === 0);
  const showPossession = $derived(variant === "live" && game.possessionTeamId !== null);

  /** Home-relative spread: negative means the home team was favoured. */
  const favoriteSide = $derived(
    game.pregameSpread === null || game.pregameSpread === 0
      ? null
      : game.pregameSpread < 0
        ? "home"
        : "away",
  );
  const spreadLabel = $derived(
    game.pregameSpread === null ? "" : `-${Math.abs(game.pregameSpread)}`,
  );

  /* Red is for things that are happening now. "UPSET POTENTIAL" stays blue,
     since the upset has not actually happened yet. */
  const HOT_TAGS = new Set([
    "INSTANT CLASSIC",
    "OVERTIME",
    "GAME ON THE LINE",
    "UPSET ALERT",
    "BIG UPSET",
  ]);
</script>

<article class="card" class:unavailable style="--accent: {accent}">
  <div class="rail"></div>

  <div class="score-col">
    <div class="score-num mono">{Math.round(score)}</div>
  </div>

  <div class="main">
    <div class="teams">
      {#each [game.away, game.home] as team (team.id)}
        <div class="team" class:dim={leader !== null && leader !== team.homeAway}>
          {#if team.logo}
            <img class="logo" src={team.logo} alt="" loading="lazy" />
          {:else}
            <span class="logo placeholder" style="background: {teamColor(team)}"></span>
          {/if}
          {#if team.rank}<span class="rank-badge mono">{team.rank}</span>{/if}
          <span class="team-name">{team.name}</span>
          <span class="record mono">{team.record}</span>
          {#if favoriteSide === team.homeAway}
            <span class="spread mono" title="Pregame closing line, not a live line.">
              {spreadLabel}
            </span>
          {/if}
          {#if showPossession && game.possessionTeamId === team.id}
            <svg class="poss" viewBox="0 0 16 10" role="img" aria-label="has the ball">
              <ellipse cx="8" cy="5" rx="7.1" ry="4.1" fill="currentColor" />
              <line x1="5.4" y1="5" x2="10.6" y2="5" stroke="var(--bg-card)" stroke-width="1.3" />
            </svg>
          {/if}
          <span class="team-score mono">{team.score}</span>
        </div>
      {/each}
    </div>

    {#if showWp}
      <WinProbBar home={game.home} away={game.away} homeWinProb={game.homeWinProb ?? 0.5} />
    {/if}

    <!-- Where the game is right now: clock and situation together. A finished game
         has no clock or situation, so it skips this line entirely and puts FINAL
         in with the other labels rather than stranding it on a line of its own. -->
    {#if variant === "live"}
      <div class="meta">
        <span class="live-dot"></span>
        <span class="mono clock">{clockText}</span>
        {#if game.downDistance}
          <span class="down mono" class:redzone={game.isRedZone}>{game.downDistance}</span>
        {/if}
      </div>
    {/if}

    <!-- Labels: how to watch it, and what kind of game it is. -->
    <div class="chips">
      {#if variant === "final"}<span class="final-chip">FINAL</span>{/if}
      {#if game.broadcast}<span class="channel-chip">{game.broadcast}</span>{/if}
      {#if !game.nationalBroadcast}<span class="note warn">local feed</span>{/if}
      <!-- Only shown once a postal code makes the answer real. Before that every
           1:00 game is equally "regional", which is noise rather than a signal. -->
      <!-- Only the exclusion. The channel chip already says CBS or FOX, and the
           grid's call signs span neighbouring markets whose affiliates this viewer
           cannot receive, so naming them was noise at best and wrong at worst. -->
      {#if unavailable}<span class="note">not on your channels</span>{/if}
      {#if game.conferenceGame}<span class="note">conference game</span>{/if}
      {#each game.tags as tag (tag)}
        <span class="tag" class:hot={HOT_TAGS.has(tag)}>{tag}</span>
      {/each}
    </div>

    {#if variant === "live" && game.lastPlay}
      <p class="last-play">{game.lastPlay}</p>
    {/if}
  </div>
</article>

<style>
  .card {
    position: relative;
    display: grid;
    grid-template-columns: 6px 68px 1fr;
    gap: 0 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 18px 14px 0;
    overflow: hidden;
    transition: border-color 0.15s ease, background 0.15s ease, opacity 0.15s ease;
  }
  /* Gated on a real pointer. On touch, tapping latches :hover until you tap
     elsewhere, so the card would just look stuck in a highlighted state. */
  @media (hover: hover) {
    .card:hover {
      background: var(--bg-card-hi);
      border-color: var(--border-hi);
    }
  }
  .rail {
    background: var(--accent);
  }
  .score-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
  }
  .score-num {
    font-size: 30px;
    font-weight: 700;
    line-height: 1;
    color: var(--accent);
  }
  .main {
    min-width: 0;
  }
  .teams {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .team {
    display: flex;
    align-items: center;
    gap: 8px;
    transition: opacity 0.15s ease;
  }
  .team.dim {
    opacity: 0.62;
  }
  .poss {
    width: 15px;
    height: 9px;
    flex: none;
    color: var(--warm);
  }
  .logo {
    width: 22px;
    height: 22px;
    object-fit: contain;
    flex: none;
  }
  .logo.placeholder {
    border-radius: 50%;
  }
  .rank-badge {
    font-size: 11px;
    color: var(--warm);
    font-weight: 700;
    flex: none;
  }
  .team-name {
    font-weight: 600;
    font-size: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .record {
    font-size: 11px;
    color: var(--text-faint);
    flex: none;
  }
  /* Team-specific, like the record, so it lives on the team row rather than in
     the game-level chip strip. */
  .spread {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
    flex: none;
  }
  .team-score {
    margin-left: auto;
    font-size: 19px;
    font-weight: 700;
    flex: none;
  }
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--hot);
    box-shadow: 0 0 0 0 rgba(255, 77, 79, 0.7);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    70% {
      box-shadow: 0 0 0 7px rgba(255, 77, 79, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 77, 79, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-dot {
      animation: none;
    }
  }
  .clock {
    color: var(--text);
    font-weight: 600;
  }
  .final-chip {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    border: 1px solid var(--border-hi);
    border-radius: 4px;
    padding: 1px 5px;
  }
  /* Chip-shaped so the row lines up, but deliberately quieter than a tag: no
     fill, no uppercase, muted border. This is background info, not a signal. */
  .note {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--border);
    color: var(--text-faint);
  }
  .note.warn {
    color: var(--warm);
    border-color: rgba(255, 165, 61, 0.35);
  }
  /* An absence, not a warning. The row is already sorted down and faded; a
     color here would shout about the games you are least likely to want. */
  .card.unavailable {
    opacity: 0.55;
  }
  /* Clock and situation are both mono digits, so without a rule between them
     "0:50 3rd 2nd & 10 at SMU 39" reads as one run-on string. */
  .down {
    padding-left: 12px;
    border-left: 1px solid var(--border-hi);
    color: var(--text-dim);
    font-weight: 500;
  }
  .down.redzone {
    color: var(--hot);
    font-weight: 600;
  }
  .chips {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin-top: 10px;
  }
  .chips:empty {
    display: none;
  }
  .tag {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(77, 157, 255, 0.12);
    color: var(--cool);
    border: 1px solid rgba(77, 157, 255, 0.25);
  }
  .tag.hot {
    background: rgba(255, 77, 79, 0.14);
    color: var(--hot);
    border-color: rgba(255, 77, 79, 0.3);
  }
  .last-play {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (max-width: 560px) {
    .card {
      grid-template-columns: 5px 52px 1fr;
      gap: 0 10px;
      padding-right: 12px;
    }
    .score-num {
      font-size: 24px;
    }
  }
</style>
