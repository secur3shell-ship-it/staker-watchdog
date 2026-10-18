export function calculateCommissionScore(
  inflationCommissionBps: number | null,
  blockRevenueCommissionBps: number | null
): number | null {
  if (inflationCommissionBps === null || blockRevenueCommissionBps === null) {
    return null;
  }

  if (
    !Number.isFinite(inflationCommissionBps) ||
    !Number.isFinite(blockRevenueCommissionBps) ||
    inflationCommissionBps < 0 ||
    blockRevenueCommissionBps < 0
  ) {
    return null;
  }

  const cappedInflation = Math.min(inflationCommissionBps, 10_000);
  const cappedBlockRevenue = Math.min(blockRevenueCommissionBps, 10_000);
  return Math.round((100 - (cappedInflation + cappedBlockRevenue) / 200) * 10) / 10;
}
