import { describe, expect, it } from 'vitest';
import { personalEntryAllowed } from '../src/renderer/personal/entry-policy';

describe('personal renderer entry', () => {
  it('renders the same workspace in a loopback HTTP browser without a native bridge', () => {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(personalEntryAllowed({ hasBridge: false, protocol: 'http:', hostname })).toBe(true);
    }
  });
  it('keeps a missing preload bridge fatal for native file documents', () => {
    expect(personalEntryAllowed({ hasBridge: false, protocol: 'file:', hostname: '' })).toBe(false);
    expect(personalEntryAllowed({ hasBridge: true, protocol: 'file:', hostname: '' })).toBe(true);
  });
  it('does not turn remote or opaque documents into browser workspaces', () => {
    for (const [protocol, hostname] of [['http:', 'example.com'], ['http:', '127.0.0.1.example.com'], ['https:', 'localhost'], ['data:', '']]) {
      expect(personalEntryAllowed({ hasBridge: false, protocol, hostname })).toBe(false);
    }
  });
});
