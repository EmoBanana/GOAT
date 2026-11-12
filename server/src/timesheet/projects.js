import fs from 'node:fs';

// ISO 19650 file names: ALP-GAM-ZZ-XX-M3-S-0001.rvt -> project field "ALP".
export const ISO19650 = /\b([A-Z0-9]{2,8})-[A-Z0-9]{2,6}-[A-Z0-9]{1,6}-[A-Z0-9]{1,6}-[A-Z0-9]{1,3}-[A-Z0-9]{1,3}-\d{2,6}\b/;

export function loadProjects(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return createProjectMatcher(raw);
}

export function createProjectMatcher(raw) {
  const lower = (list) => new Set((list || []).map((a) => String(a).toLowerCase()));
  const tracked = lower(raw.trackedApps);
  const browsers = lower(raw.browserApps);
  const projects = (raw.projects || []).map((p) => ({ code: p.code, name: p.name || p.code, patterns: (p.patterns || []).map((s) => new RegExp(s, 'i')) }));
  const iso = raw.iso19650 !== false;

  // First project whose pattern matches the title or URL, else the ISO 19650 project field.
  function projectFor(...texts) {
    const hay = texts.filter(Boolean).join('\n');
    if (!hay) return null;
    for (const p of projects) if (p.patterns.some((re) => re.test(hay))) return { code: p.code, name: p.name };
    if (iso) {
      const m = ISO19650.exec(hay);
      if (m) return { code: m[1], name: `${m[1]} (from the file name)` };
    }
    return null;
  }

  return {
    trackedApps: raw.trackedApps || [],
    browserApps: raw.browserApps || [],
    isTracked: (app) => tracked.has(String(app).toLowerCase()),
    isBrowser: (app) => browsers.has(String(app).toLowerCase()),
    names: projects.map((p) => p.name),
    projectFor,
  };
}
