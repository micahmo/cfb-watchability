import type { League, Snapshot } from "../../shared/types";

export async function fetchSnapshot(
  league: League,
  zip: string | null,
  marketOff: boolean,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const query = new URLSearchParams({ league });
  // An explicit opt-out has to travel, because the server would otherwise fall
  // back to the location header and hand back a market they said they did not want.
  if (marketOff) query.set("market", "off");
  else if (zip) query.set("zip", zip);
  const res = await fetch(`/api/snapshot?${query}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Snapshot request failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}
