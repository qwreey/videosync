/**
 * The userscript metadata block, with its `@match` lines generated from the
 * built-in provider descriptors -- the same list the extension's manifest is
 * generated from. `meta.txt` holds one placeholder line where they go.
 */
export const PLACEHOLDER = '// @match-providers';

export function renderMeta(template, patterns) {
  const lines = template.trimEnd().split('\n');
  const at = lines.indexOf(PLACEHOLDER);
  if (at < 0) throw new Error(`meta.txt: no "${PLACEHOLDER}" line to expand`);
  if (!patterns.length) throw new Error('no built-in provider pages: the script would run nowhere');
  const matches = patterns.map((p) => `// @match        ${p}`);
  return [...lines.slice(0, at), ...matches, ...lines.slice(at + 1)].join('\n');
}
