import { desktopCapturer, screen, systemPreferences } from 'electron';
import { setTimeout as sleep } from 'node:timers/promises';
import { fitWithin, toCrop } from './region.js';

// 1x1 PNG for GOAT_FAKE_CAPTURE=1 (tests can't grant Screen Recording).
const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function captureError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Reads only the highlighted region (global screen points) and returns a base64 PNG, longest
// side ≤ 1024 px. The overlay is hidden for a moment so the rectangle and cursor aren't in it.
// Nothing is stored.
export async function captureRegion(region, { win, fake = false } = {}) {
  if (fake) return FAKE_PNG;
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    throw captureError(
      'screen_permission',
      'GOAT needs Screen Recording to read the highlighted area. Allow it in System Settings > Privacy & Security > Screen Recording, then restart GOAT.',
    );
  }
  const display = screen.getDisplayMatching(region);
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };

  win?.setOpacity(0);
  let sources;
  try {
    await sleep(80); // let one frame go by without the overlay
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  } finally {
    win?.setOpacity(1);
  }
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw captureError('capture_failed', "Couldn't read the screen. Check Screen Recording in System Settings > Privacy & Security.");
  }
  const thumb = source.thumbnail.getSize();
  const crop = toCrop(region, display, thumb);
  if (!crop) throw captureError('capture_failed', 'The highlighted area is off the screen.');
  let image = source.thumbnail.crop(crop);
  const target = fitWithin(image.getSize(), 1024);
  if (target.width !== crop.width || target.height !== crop.height) image = image.resize({ ...target, quality: 'good' });
  return image.toPNG().toString('base64');
}
