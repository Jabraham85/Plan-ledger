// util.mjs — a fixture source file exercising the code-kind chunker path.
// Leading comment blocks should attach to the declaration that follows them,
// and brace-balanced runs must never be split across a chunk boundary.

export function clampYield(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// qualityBand maps a numeric roll to one of the five resource quality tiers.
// The thresholds are illustrative fixture data, not real tuning.
export function qualityBand(roll) {
  if (roll < 0.2) return 'crude';
  if (roll < 0.5) return 'common';
  if (roll < 0.8) return 'fine';
  if (roll < 0.95) return 'pristine';
  return 'flawless';
}

export const HARVESTER_TIERS = Object.freeze([
  { tier: 1, richness: 'poor' },
  { tier: 2, richness: 'common' },
  { tier: 3, richness: 'rich' },
]);
