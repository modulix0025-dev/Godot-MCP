// SPDX-License-Identifier: Apache-2.0
//
// Polls Core's owner endpoints. Every resource is fetched independently, so one failing endpoint shows its own
// error state instead of blanking the whole app. Core pushes no events yet; a 2.5 s poll keeps pipeline progress
// and approvals live.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreClient } from './client';
import type { Snapshot } from './types';

const PARTS: [Exclude<keyof Snapshot, 'errors'>, string][] = [
  ['health', '/health'],
  ['projects', '/projects'],
  ['approvals', '/approvals'],
  ['audit', '/audit'],
  ['setup', '/setup'],
  ['buildWorkers', '/build-workers'],
  ['workers', '/workers'],
  ['budget', '/budget'],
  ['devMode', '/dev-mode'],
];

export const EMPTY_SNAPSHOT: Snapshot = {
  health: null,
  projects: null,
  approvals: null,
  audit: null,
  setup: null,
  buildWorkers: null,
  workers: null,
  budget: null,
  devMode: null,
  errors: {},
};

export async function loadSnapshot(client: CoreClient): Promise<Snapshot> {
  const results = await Promise.allSettled(PARTS.map(([, path]) => client.get<unknown>(path)));
  const snap: Snapshot = { ...EMPTY_SNAPSHOT, errors: {} };
  results.forEach((r, i) => {
    const key = PARTS[i]![0];
    if (r.status === 'fulfilled') (snap as unknown as Record<string, unknown>)[key] = r.value;
    else snap.errors[key] = (r.reason as Error).message;
  });
  return snap;
}

export function useSnapshot(client: CoreClient | null, intervalMs = 2500) {
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!client) return;
    const s = await loadSnapshot(client);
    if (alive.current) {
      setSnap(s);
      setLoaded(true);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh, intervalMs]);
  return { snap, loaded, refresh };
}
