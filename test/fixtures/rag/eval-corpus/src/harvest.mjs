// harvest.mjs — yield computation for the harvester tool (fixture source).
// Pure functions; the yield modifier stacks additively from tool tier and
// multiplicatively from node richness, mirroring the gathering guide.

// clampYield constrains a computed yield to the sane [min, max] window so a
// pathological richness multiplier can never return a negative or runaway amount.
export function clampYield(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// richnessMultiplier maps a named node richness to its multiplicative factor.
export function richnessMultiplier(richness) {
  switch (richness) {
    case 'poor': return 0.5;
    case 'common': return 1.0;
    case 'rich': return 1.5;
    default: return 1.0;
  }
}

// The Harvester carries a tool tier and computes the per-swing yield for a node.
export class Harvester {
  constructor(tier = 1) {
    this.tier = tier;
  }

  // computeYield: base output plus the additive tool-tier bonus, then scaled by
  // the multiplicative node richness factor, finally clamped to a safe window.
  computeYield(baseOutput, richness) {
    const additive = baseOutput + this.tier;
    const scaled = additive * richnessMultiplier(richness);
    return clampYield(scaled, 1, 999);
  }
}
