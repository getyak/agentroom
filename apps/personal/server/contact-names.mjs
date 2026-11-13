const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const width = value => [...segments.segment(value)].reduce((total, { segment }) => total + (/^[\x20-\x7e]+$/.test(segment) ? segment.length : 2), 0);

/** Provider titles are untrusted labels. Never infer a role from their content. */
export function suggestContactName(sourceName, fallbackName = '个人助手', suffix = 'agent') {
  const firstLine = String(sourceName || '').trim().split(/[\r\n]/, 1)[0].replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim();
  if (firstLine && width(firstLine) <= 28) return firstLine;
  const heading = firstLine.split(/\s+[·•|｜—–]\s+/, 1)[0].trim();
  if (heading && width(heading) <= 28) return heading;
  return `${fallbackName} · ${String(suffix).replace(/[^a-z0-9]/gi, '').slice(-6) || 'agent'}`;
}

export function discoveredContactName(previous, sourceName, fallbackName, suffix) {
  // Legacy edits may have changed only configuration. Preserve them anyway:
  // absence of a rename receipt is not proof that a user chose no name.
  const untouched = previous && !previous.nameSource && previous.version === 1 && !previous.updatedAt
    && typeof previous.providerName === 'string' && previous.name === previous.providerName;
  const automatic = !previous || previous.nameSource === 'provider' || untouched;
  return { name: automatic ? suggestContactName(sourceName, fallbackName, suffix) : previous.name,
    sourceName, nameSource: automatic ? 'provider' : 'custom' };
}
