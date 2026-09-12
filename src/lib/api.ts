import type { League, Snapshot } from "../../shared/types";

/** The query that identifies one viewer's board, shared by the poll and the stream. */
function boardQuery(league: League, zip: string | null, marketOff: boolean): URLSearchParams {
  const query = new URLSearchParams({ league });
  // An explicit opt-out has to travel, because the server would otherwise fall
  // back to the location header and hand back a market they said they did not want.
  if (marketOff) query.set("market", "off");
  else if (zip) query.set("zip", zip);
  return query;
}

/**
 * Opens a live stream of the board, falling back to nothing if it cannot.
 *
 * The poll stays in place underneath: a stream that never connects, or that a
 * proxy quietly buffers, has to cost freshness rather than the board. `onerror`
 * is not fatal either, since EventSource reconnects on its own and the poll
 * covers the gap while it does.
 */
export function openBoardStream(
  league: League,
  zip: string | null,
  marketOff: boolean,
  onSnapshot: (snapshot: Snapshot) => void,
): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  const source = new EventSource(`/api/stream?${boardQuery(league, zip, marketOff)}`);
  source.addEventListener("snapshot", (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent).data) as Snapshot);
    } catch {
      // A malformed frame changes nothing; the next one, or the poll, corrects it.
    }
  });
  return () => source.close();
}

export async function fetchSnapshot(
  league: League,
  zip: string | null,
  marketOff: boolean,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const query = boardQuery(league, zip, marketOff);
  const res = await fetch(`/api/snapshot?${query}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Snapshot request failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}

