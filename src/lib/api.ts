import type { Snapshot } from "../../shared/types";

export async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  const res = await fetch("/api/snapshot", { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Snapshot request failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}
