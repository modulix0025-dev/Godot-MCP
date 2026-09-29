// SPDX-License-Identifier: Apache-2.0
//
// Production screens are built only after the Phase 3 UI Direction Review is approved. Until then the app
// renders a placeholder, and the clickable review prototype lives at #/prototype.
import { useEffect, useState } from 'react';
import { Prototype } from './prototype/Prototype';

export function App() {
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (hash.startsWith('#/prototype')) return <Prototype />;
  return (
    <main style={{ padding: 32, fontFamily: 'system-ui, sans-serif' }}>
      <h1>ModuleX Game Studio</h1>
      <p>Built with the Godot Engine (MIT).</p>
      <p>
        <a href="#/prototype/studio">Open the UI Direction Review prototype</a>
      </p>
    </main>
  );
}
