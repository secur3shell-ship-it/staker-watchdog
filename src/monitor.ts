import { calculateCommissionScore } from "./scoring.js";
import type { ValidatorAlert, ValidatorSnapshot, ValidatorRpcEntry } from "./types.js";
import { SolanaRpc } from "./rpc.js";
import { WatchdogStore } from "./store.js";
import { LEGACY_VOTE_STATE_VERSIONS, VOTE_STATE_V4 } from "./vote-account.js";

export interface MonitorUpdate {
  slot: number;
  epoch: number;
  validatorCount: number;
  alerts: ValidatorAlert[];
  syncedAt: string;
}

// A sync that would remove more than this share of active validators is more
// likely a truncated RPC response than a real exodus, so removals are skipped.
const MAX_REMOVAL_FRACTION = 0.2;
const MIN_REMOVAL_GUARD = 10;

export class ValidatorMonitor {
  private syncing = false;

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly store: WatchdogStore,
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
      const { details, failures } = await this.rpc.getVoteStateDetails(
        all.map(({ entry }) => entry.votePubkey)
      );
      if (failures.size) {
        const examples = [...failures].slice(0, 5)
          .map(([votePubkey, reason]) => `${votePubkey}: ${reason}`)
          .join("; ");
        console.warn(
          `Could not read vote state for ${failures.size} account(s); keeping their last known ` +
          `commission data. ${examples}`
        );
      }
      const previousByVote = new Map(
        this.store.listValidators().map((validator) => [validator.votePubkey, validator])
      );
      const updatedAt = new Date().toISOString();
      const snapshots: ValidatorSnapshot[] = all.map(({ entry, status }) => {
        const observed = {
          votePubkey: entry.votePubkey,
          nodePubkey: entry.nodePubkey,
          status,
          activeStakeLamports: String(entry.activatedStake),
          rootSlot: String(entry.rootSlot),
          lastVote: String(entry.lastVote),
          updatedAt
        };
        const state = details.get(entry.votePubkey);
        if (!state) {
          // Unreadable this sync: carry the last decoded configuration forward so a
          // transient gap neither erases it nor hides a change made during the gap.
          const previous = previousByVote.get(entry.votePubkey);
          if (previous) {
            return {
              ...observed,
              voteStateVersion: previous.voteStateVersion,
              commissionSource: previous.commissionSource,
              inflationCommissionBps: previous.inflationCommissionBps,
              blockRevenueCommissionBps: previous.blockRevenueCommissionBps,
              inflationCollector: previous.inflationCollector,
              blockRevenueCollector: previous.blockRevenueCollector,
              commissionScore: previous.commissionScore
            };
          }
        }
        const isV4 = state?.version === VOTE_STATE_V4;
        const isLegacy = state !== undefined && LEGACY_VOTE_STATE_VERSIONS.has(state.version);
        const inflationCommissionBps = isV4
          ? state.inflationCommissionBps
          : Number(entry.commission) * 100;
        const blockRevenueCommissionBps = isV4
          ? state.blockRevenueCommissionBps
          : isLegacy ? 10_000 : null;
        return {
          ...observed,
          voteStateVersion: state?.version ?? null,
          commissionSource: isV4
            ? "vote_state_v4"
            : isLegacy ? "legacy_migration_default" : null,
          inflationCommissionBps,
          blockRevenueCommissionBps,
          inflationCollector: isV4
            ? state.inflationCollector
            : isLegacy ? entry.votePubkey : null,
          blockRevenueCollector: isV4
            ? state.blockRevenueCollector
            : isLegacy ? entry.nodePubkey : null,
          commissionScore: calculateCommissionScore(
            inflationCommissionBps,
            blockRevenueCommissionBps
          )
        };
      });

      const reported = new Set(snapshots.map(({ votePubkey }) => votePubkey));
      const activeBefore = [...previousByVote.values()].filter(
        ({ status }) => status !== "inactive"
      );
      let removed = activeBefore
        .filter(({ votePubkey }) => !reported.has(votePubkey))
        .map(({ votePubkey }) => votePubkey);
      const removalLimit = Math.max(
        MIN_REMOVAL_GUARD,
        Math.ceil(activeBefore.length * MAX_REMOVAL_FRACTION)
      );
      if (removed.length > removalLimit) {
        console.warn(
          `RPC omitted ${removed.length} of ${activeBefore.length} known validators; ` +
          "not marking them inactive because the response may be incomplete"
        );
        removed = [];
      }

      const alerts = this.store.applySnapshot(snapshots, slot, epoch, removed);
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
      console.info(
        `Synced ${snapshots.length} validators at slot ${slot} (epoch ${epoch})`
      );
    } finally {
      this.syncing = false;
    }
  }
}
