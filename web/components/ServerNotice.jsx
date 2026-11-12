'use client';

import { useEffect, useState } from 'react';
import { isLocal } from '@/lib/format';

// A build made for a GOAT server on the same computer (127.0.0.1) only answers where that server
// runs, so anyone downloading it from this page elsewhere (Vercel) gets an app that can't answer.
// The page says so until the builds name a hosted server (npm run package -- --server <url>).
// Served by the GOAT server itself (the pitch Mac, the tests), the server is right there.
export function ServerNotice({ serverUrl, className = '' }) {
  const [onServer, setOnServer] = useState(false);
  useEffect(() => {
    setOnServer(isLocal(window.location.href));
  }, []);
  if (!isLocal(serverUrl) || onServer) return null;
  return (
    <p className={`server-note ${className}`.trim()} data-server-note>
      <span className="server-light" aria-hidden="true" />
      <span>GOAT’s server isn’t online right now. The app installs, but can’t answer until it is.</span>
    </p>
  );
}
