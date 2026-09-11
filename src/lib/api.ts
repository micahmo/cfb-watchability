import type { League, Snapshot } from "../../shared/types";

export async function fetchSnapshot(league: League, signal?: AbortSignal): Promise<Snapshot> {
  const res = await fetch(`/api/snapshot?league=${league}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Snapshot request failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}
