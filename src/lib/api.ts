import type { League, Snapshot } from "../../shared/types";

export async function fetchSnapshot(
  league: League,
  zip: string | null,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const query = new URLSearchParams({ league });
  if (zip) query.set("zip", zip);
  const res = await fetch(`/api/snapshot?${query}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Snapshot request failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}
