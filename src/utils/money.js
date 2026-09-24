// Money helpers. All amounts are handled to 2 decimal places.
// We round via integer cents to avoid floating-point drift.

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toCents(n) {
  return Math.round(Number(n) * 100);
}

function fromCents(c) {
  return c / 100;
}

// percent is a plain number where 1.5 means 1.5%. e.g. percentOf(1000, 1.5) => 15
function percentOf(amount, percent) {
  return round2((Number(amount) * Number(percent)) / 100);
}

module.exports = { round2, toCents, fromCents, percentOf };
