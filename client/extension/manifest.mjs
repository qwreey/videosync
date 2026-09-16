/**
 * The two manifests, from `manifest.json` plus the built-in descriptors.
 *
 * `content_scripts.matches` is generated, never hand-written: the pages the
 * extension runs on are the built-in descriptors' `pageHosts`
 * (client/core/scripts/providers.mjs), the same list the userscript's
 * `@match` lines come from. Three hand-kept host lists used to drift.
 *
 * Sites the user adds later are not here: they are optional host permissions,
 * granted at run time from the options page, and the content script is
 * registered for them then (src/dynamic.ts). Neither widens the install
 * prompt -- optional hosts are not shown at install.
 */

/** Chrome, Manifest V3. */
export function chromeManifest(base, patterns) {
  const m = structuredClone(base);
  if (!m.content_scripts?.length) throw new Error('manifest.json: no content_scripts entry to fill');
  m.content_scripts[0].matches = [...patterns];
  return m;
}

/**
 * Firefox, Manifest V2 (see build.mjs for why V2). Optional origins go in
 * `optional_permissions` there; `optional_host_permissions` is MV3-only.
 */
export function firefoxManifest(base, patterns) {
  const c = chromeManifest(base, patterns);
  return {
    manifest_version: 2,
    name: c.name,
    version: c.version,
    description: c.description,
    permissions: c.permissions,
    optional_permissions: c.optional_host_permissions ?? [],
    background: { scripts: ['sw.js'], persistent: false },
    content_scripts: c.content_scripts,
    options_ui: c.options_ui,
    browser_specific_settings: {
      gecko: { id: 'videosync@videosync.invalid', strict_min_version: '128.0' },
    },
  };
}
