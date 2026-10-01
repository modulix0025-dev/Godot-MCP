// SPDX-License-Identifier: Apache-2.0
//
// The desktop app: the production UI (wired to Studio Core) everywhere, and the Phase 3 review prototype at
// #/prototype for design reference and screenshot regression.
import { useEffect, useState } from 'react';
import { Prototype } from './prototype/Prototype';
import { StudioApp } from './studio/StudioApp';

export function App() {
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (hash.startsWith('#/prototype')) return <Prototype />;
  return <StudioApp />;
}
