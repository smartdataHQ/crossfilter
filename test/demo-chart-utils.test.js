import { describe, expect, it } from 'vitest';
import {
  HORIZONTAL_BAR_AXIS_LABEL_WIDTH,
  HORIZONTAL_BAR_MAX_HEIGHT,
  HORIZONTAL_BAR_MIN_HEIGHT,
  resolveHorizontalBarChartHeight,
  truncateHorizontalBarLabel,
} from '../demo/chart-utils.js';

describe('demo chart utils', () => {
  it('truncates long horizontal bar labels without changing short labels', () => {
    expect(truncateHorizontalBarLabel('Short label')).toBe('Short label');
    expect(truncateHorizontalBarLabel('A very long horizontal bar label that should be clipped')).toBe('A very long horiz…');
  });

  it('sizes horizontal bar charts by row count rather than label length', () => {
    expect(resolveHorizontalBarChartHeight(3)).toBe(resolveHorizontalBarChartHeight(3));
    expect(resolveHorizontalBarChartHeight(3)).toBeGreaterThanOrEqual(HORIZONTAL_BAR_MIN_HEIGHT);
    expect(resolveHorizontalBarChartHeight(100)).toBe(HORIZONTAL_BAR_MAX_HEIGHT);
  });

  it('keeps ranked chart axis width bounded so labels cannot consume the whole plot area', () => {
    expect(HORIZONTAL_BAR_AXIS_LABEL_WIDTH).toBeLessThanOrEqual(120);
  });
});
