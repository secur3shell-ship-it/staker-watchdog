// "inactive" means the vote account is no longer returned by getVoteAccounts
// (closed or fully unstaked); its last observed configuration is kept.
export type ValidatorStatus = "current" | "delinquent" | "inactive";

export interface ValidatorSnapshot {
  votePubkey: string;
  nodePubkey: string;
  voteStateVersion: number | null;
  commissionSource: "vote_state_v4" | "legacy_migration_default" | null;
  status: ValidatorStatus;
  activeStakeLamports: string;
  inflationCommissionBps: number | null;
  blockRevenueCommissionBps: number | null;
  inflationCollector: string | null;
  blockRevenueCollector: string | null;
  rootSlot: string;
  lastVote: string;
  commissionScore: number | null;
  updatedAt: string;
}

export type AlertField =
  | "inflation_commission"
  | "block_revenue_commission"
  | "inflation_collector"
  | "block_revenue_collector"
  | "validator_status";

export interface ValidatorAlert {
  id: number;
  votePubkey: string;
  nodePubkey: string;
  field: AlertField;
  previousValue: string | null;
  newValue: string | null;
  detectedAt: string;
}

export type HistoryEventType =
  | "baseline"
  | "configuration_change"
  | "status_change"
  | "identity_change"
  | "source_change"
  | "configuration_and_status_change";

export interface ValidatorHistoryEntry {
  id: number;
  votePubkey: string;
  nodePubkey: string;
  status: ValidatorStatus;
  eventType: HistoryEventType;
  inflationCommissionBps: number | null;
  blockRevenueCommissionBps: number | null;
  inflationCollector: string | null;
  blockRevenueCollector: string | null;
  commissionSource: ValidatorSnapshot["commissionSource"];
  slot: string;
  recordedAt: string;
}

export interface ValidatorRpcEntry {
  votePubkey: string;
  nodePubkey: string;
  activatedStake: number | string;
  commission: number | string;
  rootSlot: number | string;
  lastVote: number | string;
  epochVoteAccount: boolean;
}

export interface VoteAccountDetails {
  /** Layout version (0 = V0_23_5, 1 = V1_14_11, 3 = V3, 4 = V4), not the raw enum tag. */
  version: number;
  inflationCommissionBps: number | null;
  blockRevenueCommissionBps: number | null;
  inflationCollector: string | null;
  blockRevenueCollector: string | null;
}

export interface VoteStateLookup {
  details: Map<string, VoteAccountDetails>;
  /** Vote accounts whose state could not be read this sync, with the reason. */
  failures: Map<string, string>;
}
