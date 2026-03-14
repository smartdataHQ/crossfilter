import { describe, expect, it } from 'vitest';
import {
  isLiveApiProbeStatusAvailable,
  parseDemoPreferences,
  resolvePreferredDataSource,
  sanitizeStoredDataSource,
  sanitizeStoredGranularity,
  shouldFallbackToLocalFromLiveErrorMessage,
} from '../demo/source-utils.js';

describe('demo source utils', () => {
  it('parses stored preferences defensively', () => {
    expect(parseDemoPreferences('')).toEqual({});
    expect(parseDemoPreferences('{')).toEqual({});
    expect(parseDemoPreferences('{"dataSource":"file"}')).toEqual({ dataSource: 'file' });
  });

  it('resolves the startup source from availability and preference', () => {
    expect(resolvePreferredDataSource(null, true)).toBe('live');
    expect(resolvePreferredDataSource(null, false)).toBe('file');
    expect(resolvePreferredDataSource('live', false)).toBe('file');
    expect(resolvePreferredDataSource('file', true)).toBe('file');
  });

  it('sanitizes stored values', () => {
    expect(sanitizeStoredDataSource('live')).toBe('live');
    expect(sanitizeStoredDataSource('else')).toBe(null);
    expect(sanitizeStoredGranularity('hour', ['hour', 'day'])).toBe('hour');
    expect(sanitizeStoredGranularity('week', ['hour', 'day'])).toBe(null);
  });

  it('detects when the live endpoint exists and when to fall back locally', () => {
    expect(isLiveApiProbeStatusAvailable(204)).toBe(true);
    expect(isLiveApiProbeStatusAvailable(403)).toBe(true);
    expect(isLiveApiProbeStatusAvailable(501)).toBe(false);
    expect(shouldFallbackToLocalFromLiveErrorMessage("501 Unsupported method ('POST')")).toBe(true);
    expect(shouldFallbackToLocalFromLiveErrorMessage('404 Not Found')).toBe(true);
    expect(shouldFallbackToLocalFromLiveErrorMessage('502 Proxy timeout')).toBe(false);
  });
});
