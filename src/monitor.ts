import { calculateCommissionScore } from "./scoring.js";
import type { ValidatorAlert, ValidatorSnapshot, ValidatorRpcEntry } from "./types.js";
import { SolanaRpc } from "./rpc.js";
import { WatchdogStore } from "./store.js";

export interface MonitorUpdate {
  slot: number;
  epoch: number;
  validatorCount: number;
  alerts: ValidatorAlert[];
  syncedAt: string;
}

export class ValidatorMonitor {
  private syncing = false;

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly store: WatchdogStore,
    private readonly webhookUrl?: string,
    private readonly onUpdate?: (update: MonitorUpdate) => void
  ) {}

  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const [accounts, slot, epoch] = await Promise.all([
        this.rpc.getVoteAccounts(),
        this.rpc.getSlot(),
        this.rpc.getEpoch()
      ]);
      const all: Array<{ entry: ValidatorRpcEntry; status: "current" | "delinquent" }> = [
        ...accounts.current.map((entry) => ({ entry, status: "current" as const })),
        ...accounts.delinquent.map((entry) => ({ entry, status: "delinquent" as const }))
      ];
      if (all.length === 0) {
        throw new Error("RPC returned no vote accounts; preserving the last good snapshot");
      }
      const details = await this.rpc.getVoteStateDetails(
        all.map(({ entry }) => entry.votePubkey)
      );
      const updatedAt = new Date().toISOString();
      const snapshots: ValidatorSnapshot[] = all.map(({ entry, status }) => {
        const state = details.get(entry.votePubkey);
        const isV4 = state?.version === 4;
        const isLegacy = state !== undefined && state.version >= 1 && state.version <= 3;
        const inflationCommissionBps = isV4
          ? state.inflationCommissionBps
          : Number(entry.commission) * 100;
        const blockRevenueCommissionBps = isV4
          ? state.blockRevenueCommissionBps
          : isLegacy ? 10_000 : null;
        return {
          votePubkey: entry.votePubkey,
          nodePubkey: entry.nodePubkey,
          voteStateVersion: state?.version ?? null,
          commissionSource: isV4
            ? "vote_state_v4"
            : isLegacy ? "legacy_migration_default" : null,
          status,
          activeStakeLamports: String(entry.activatedStake),
          inflationCommissionBps,
          blockRevenueCommissionBps,
          inflationCollector: isV4
            ? state.inflationCollector
            : isLegacy ? entry.votePubkey : null,
          blockRevenueCollector: isV4
            ? state.blockRevenueCollector
            : isLegacy ? entry.nodePubkey : null,
          rootSlot: String(entry.rootSlot),
          lastVote: String(entry.lastVote),
          commissionScore: calculateCommissionScore(
            inflationCommissionBps,
            blockRevenueCommissionBps
          ),
          updatedAt
        };
      });

      const alerts = this.store.applySnapshot(snapshots, slot, epoch);
      this.onUpdate?.({
        slot,
        epoch,
        validatorCount: snapshots.length,
        alerts,
        syncedAt: updatedAt
      });
      if (alerts.length) {
        console.info(`Detected ${alerts.length} validator configuration change(s)`);
      }
      for (const alert of alerts) {
        try {
          await this.sendAlert(alert);
        } catch (error) {
          console.error(`Failed to deliver webhook for alert ${alert.id}:`, error);
        }
      }
      console.info(
        `Synced ${snapshots.length} validators at slot ${slot} (epoch ${epoch})`
      );
    } finally {
      this.syncing = false;
    }
  }

  private async sendAlert(alert: unknown): Promise<void> {
    if (!this.webhookUrl) return;
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`Alert webhook failed with HTTP ${response.status}`);
    }
  }
}
