export type ValidatorStatus = "current" | "delinquent";

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
  version: number;
  inflationCommissionBps: number | null;
  blockRevenueCommissionBps: number | null;
  inflationCollector: string | null;
  blockRevenueCollector: string | null;
}
