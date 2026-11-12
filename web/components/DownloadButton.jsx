'use client';

import { useEffect, useState } from 'react';

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
const LABELS = { darwin: 'Download for Mac', win32: 'Download for Windows' };

// Downloads from Vercel Blob once the build is published there (npm run publish-build -- --upload).
// Served by a GOAT server (the pitch Mac, or the tests), the page downloads from that server's
// /download route instead. Anywhere else, an unpublished build shows as not available yet,
// rather than a link that would 404.
export function DownloadButton({ build, primary = true, large = false }) {
  const [href, setHref] = useState(build?.url || null);
  useEffect(() => {
    if (build && LOCAL.includes(window.location.hostname)) setHref(`/download/${build.file}`);
  }, [build]);
  const className = `btn${primary ? '' : ' btn-plain'}${large ? ' btn-lg' : ''}`;
  if (!build || !href) {
    return (
      <span className={className} aria-disabled="true" data-download={build?.platform}>
        {build ? `${LABELS[build.platform] || 'Download'} · not published yet` : 'Not built yet'}
      </span>
    );
  }
  return (
    <a className={className} href={href} download={build.file} data-download={build.platform}>
      {LABELS[build.platform] || 'Download'}
    </a>
  );
}

// Both downloads, the visitor's own system first.
export function DownloadButtons({ builds }) {
  const [os, setOs] = useState('darwin');
  useEffect(() => {
    if (/Windows/i.test(navigator.userAgent)) setOs('win32');
  }, []);
  const ordered = [...builds].sort((a, b) => (a.platform === os ? -1 : b.platform === os ? 1 : 0));
  return (
    <div className="dl-buttons">
      {ordered.map((build, i) => (
        <DownloadButton key={build.platform} build={build} primary={i === 0} />
      ))}
    </div>
  );
}
