// quality.mjs — resource quality tier logic (fixture source).
// The five tiers and the roll-to-band mapping mirror the gathering guide's
// "Resource Quality Tiers" section so cross-source retrieval has a code twin.

// QUALITY_TIERS lists the five named tiers from lowest to highest. Frozen so a
// caller can never mutate the canonical ordering the whole economy depends on.
export const QUALITY_TIERS = Object.freeze(['crude', 'common', 'fine', 'pristine', 'flawless']);

// bandForRoll maps a random roll in [0,1) to one of the five quality tiers. A
// richer node shifts the roll upward before this call; the thresholds here are
// the fixed cut points between adjacent bands.
export function bandForRoll(roll) {
  if (roll < 0.20) return 'crude';
  if (roll < 0.50) return 'common';
  if (roll < 0.80) return 'fine';
  if (roll < 0.95) return 'pristine';
  return 'flawless';
}

// rollQuality draws a quality band for one harvest, nudging the raw roll up by
// the node's richness bonus before mapping it through bandForRoll.
export function rollQuality(rawRoll, richnessBonus = 0) {
  const shifted = Math.min(0.999, rawRoll + richnessBonus);
  return bandForRoll(shifted);
}
