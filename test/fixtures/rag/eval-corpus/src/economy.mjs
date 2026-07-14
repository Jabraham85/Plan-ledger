// economy.mjs — credit source/sink ledger for the gatherer-crafter loop (fixture).
// Sources add credits to the economy; sinks remove them. The upgrade sink is the
// primary drain that keeps the gatherer and crafter progressions interdependent.

// SALE_MULTIPLIER converts a resource quality tier index into a sale-price factor,
// so higher-quality stock is a proportionally larger credit SOURCE at market.
export const SALE_MULTIPLIER = Object.freeze([1.0, 1.4, 2.0, 3.2, 5.0]);

// creditsForSale is a credit SOURCE: base price times the tier's sale multiplier.
export function creditsForSale(basePrice, tierIndex) {
  const factor = SALE_MULTIPLIER[tierIndex] ?? 1.0;
  return Math.round(basePrice * factor);
}

// upgradeCost is the primary credit SINK: the cost to advance the harvester from
// its current tier to the next one grows super-linearly so late upgrades stay a
// meaningful drain and the economy never floods with idle credits.
export function upgradeCost(currentTier) {
  const next = currentTier + 1;
  return 100 * next * next;
}

// netLedger sums a list of signed credit movements (sources positive, sinks
// negative) to report whether the economy is inflating or draining over a window.
export function netLedger(movements) {
  return movements.reduce((total, delta) => total + delta, 0);
}
