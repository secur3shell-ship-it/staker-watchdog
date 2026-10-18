import Database from "better-sqlite3";
import type {
  AlertField,
  HistoryEventType,
  ValidatorAlert,
  ValidatorHistoryEntry,
  ValidatorSnapshot
} from "./types.js";

const CHANGE_FIELDS: Array<{
  key: AlertField;
  property: keyof ValidatorSnapshot;
}> = [
  { key: "inflation_commission", property: "inflationCommissionBps" },
  { key: "block_revenue_commission", property: "blockRevenueCommissionBps" },
  { key: "inflation_collector", property: "inflationCollector" },
  { key: "block_revenue_collector", property: "blockRevenueCollector" }
];

export class WatchdogStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS validators (
        vote_pubkey TEXT PRIMARY KEY,
        node_pubkey TEXT NOT NULL,
        vote_state_version INTEGER,
        commission_source TEXT,
        status TEXT NOT NULL,
        active_stake_lamports TEXT NOT NULL,
        inflation_commission_bps INTEGER,
        block_revenue_commission_bps INTEGER,
        inflation_collector TEXT,
        block_revenue_collector TEXT,
        root_slot TEXT NOT NULL,
        last_vote TEXT NOT NULL,
        commission_score REAL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vote_pubkey TEXT NOT NULL,
        node_pubkey TEXT NOT NULL,
        field TEXT NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        detected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alerts_detected_at_idx ON alerts(detected_at DESC);
      CREATE TABLE IF NOT EXISTS validator_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vote_pubkey TEXT NOT NULL,
        node_pubkey TEXT NOT NULL,
        status TEXT NOT NULL,
        event_type TEXT NOT NULL,
        inflation_commission_bps INTEGER,
        block_revenue_commission_bps INTEGER,
        inflation_collector TEXT,
        block_revenue_collector TEXT,
        commission_source TEXT,
        slot TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS validator_history_pubkey_id_idx
        ON validator_history(vote_pubkey, id DESC);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const validatorColumns = new Set(
      (this.db.pragma("table_info(validators)") as Array<{ name: string }>).map(
        ({ name }) => name
      )
    );
    if (!validatorColumns.has("vote_state_version")) {
      this.db.exec("ALTER TABLE validators ADD COLUMN vote_state_version INTEGER");
    }
    if (!validatorColumns.has("commission_source")) {
      this.db.exec("ALTER TABLE validators ADD COLUMN commission_source TEXT");
    }
  }

  /**
   * Persists one successful sync. `inactiveVotePubkeys` lists stored validators
   * that the RPC no longer reports; they are marked inactive with a status alert
   * while keeping their last observed configuration.
   */
  applySnapshot(
    snapshots: ValidatorSnapshot[],
    slot: number,
    epoch: number,
    inactiveVotePubkeys: string[] = []
  ): ValidatorAlert[] {
    const detectedAt = new Date().toISOString();
    const alerts: ValidatorAlert[] = [];
    const getPrevious = this.db.prepare(
      "SELECT * FROM validators WHERE vote_pubkey = ?"
    );
    const insertAlert = this.db.prepare(`
      INSERT INTO alerts (vote_pubkey, node_pubkey, field, previous_value, new_value, detected_at)
      VALUES (@votePubkey, @nodePubkey, @field, @previousValue, @newValue, @detectedAt)
    `);
    const insertHistory = this.db.prepare(`
      INSERT INTO validator_history (
        vote_pubkey, node_pubkey, status, event_type,
        inflation_commission_bps, block_revenue_commission_bps,
        inflation_collector, block_revenue_collector, commission_source,
        slot, recorded_at
      ) VALUES (
        @votePubkey, @nodePubkey, @status, @eventType,
        @inflationCommissionBps, @blockRevenueCommissionBps,
        @inflationCollector, @blockRevenueCollector, @commissionSource,
        @slot, @recordedAt
      )
    `);
    const getHistoryExists = this.db.prepare(
      "SELECT 1 AS found FROM validator_history WHERE vote_pubkey = ? LIMIT 1"
    );
    const upsertValidator = this.db.prepare(`
      INSERT INTO validators (
        vote_pubkey, node_pubkey, vote_state_version, commission_source,
        status, active_stake_lamports,
        inflation_commission_bps, block_revenue_commission_bps,
        inflation_collector, block_revenue_collector, root_slot, last_vote,
        commission_score, updated_at
      ) VALUES (
        @votePubkey, @nodePubkey, @voteStateVersion, @commissionSource,
        @status, @activeStakeLamports,
        @inflationCommissionBps, @blockRevenueCommissionBps,
        @inflationCollector, @blockRevenueCollector, @rootSlot, @lastVote,
        @commissionScore, @updatedAt
      )
      ON CONFLICT(vote_pubkey) DO UPDATE SET
        node_pubkey=excluded.node_pubkey,
        vote_state_version=excluded.vote_state_version,
        commission_source=excluded.commission_source,
        status=excluded.status,
        active_stake_lamports=excluded.active_stake_lamports,
        inflation_commission_bps=excluded.inflation_commission_bps,
        block_revenue_commission_bps=excluded.block_revenue_commission_bps,
        inflation_collector=excluded.inflation_collector,
        block_revenue_collector=excluded.block_revenue_collector,
        root_slot=excluded.root_slot,
        last_vote=excluded.last_vote,
        commission_score=excluded.commission_score,
        updated_at=excluded.updated_at
    `);
    const markInactive = this.db.prepare(
      "UPDATE validators SET status = 'inactive' WHERE vote_pubkey = ?"
    );
    const insertMetadata = this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `);

    const transaction = this.db.transaction(() => {
      for (const snapshot of snapshots) {
        const previous = getPrevious.get(snapshot.votePubkey) as
          | Record<string, string | number | null>
          | undefined;
        const hasHistory = Boolean(getHistoryExists.get(snapshot.votePubkey));
        if (previous && !hasHistory) {
          insertHistory.run({
            votePubkey: snapshot.votePubkey,
            nodePubkey: previous.node_pubkey,
            status: previous.status,
            eventType: "baseline",
            inflationCommissionBps: previous.inflation_commission_bps,
            blockRevenueCommissionBps: previous.block_revenue_commission_bps,
            inflationCollector: previous.inflation_collector,
            blockRevenueCollector: previous.block_revenue_collector,
            commissionSource: previous.commission_source,
            slot: previous.root_slot,
            recordedAt: previous.updated_at ?? detectedAt
          });
        }
        const changedFields: AlertField[] = [];
        if (previous) {
          for (const field of CHANGE_FIELDS) {
            const before = previous[columnName(field.property)];
            const after = snapshot[field.property];
            if (
              before !== null &&
              before !== undefined &&
              after !== null &&
              after !== undefined &&
              String(before) !== String(after)
            ) {
              const alert = {
                votePubkey: snapshot.votePubkey,
                nodePubkey: snapshot.nodePubkey,
                field: field.key,
                previousValue: String(before),
                newValue: String(after),
                detectedAt
              };
              const result = insertAlert.run(alert);
              alerts.push({ id: Number(result.lastInsertRowid), ...alert });
              changedFields.push(field.key);
            }
          }
          const previousStatus = String(previous.status);
          if (previousStatus !== snapshot.status) {
            const alert = {
              votePubkey: snapshot.votePubkey,
              nodePubkey: snapshot.nodePubkey,
              field: "validator_status" as const,
              previousValue: previousStatus,
              newValue: snapshot.status,
              detectedAt
            };
            const result = insertAlert.run(alert);
            alerts.push({ id: Number(result.lastInsertRowid), ...alert });
            changedFields.push("validator_status");
          }
        }
        const eventTypes = previous
          ? historyEvents(previous, snapshot, changedFields)
          : ["baseline" as const];
        for (const eventType of eventTypes) {
          insertHistory.run({
            votePubkey: snapshot.votePubkey,
            nodePubkey: snapshot.nodePubkey,
            status: snapshot.status,
            eventType,
            inflationCommissionBps: snapshot.inflationCommissionBps,
            blockRevenueCommissionBps: snapshot.blockRevenueCommissionBps,
            inflationCollector: snapshot.inflationCollector,
            blockRevenueCollector: snapshot.blockRevenueCollector,
            commissionSource: snapshot.commissionSource,
            slot: String(slot),
            recordedAt: detectedAt
          });
        }
        upsertValidator.run(snapshot);
      }
      for (const votePubkey of inactiveVotePubkeys) {
        const previous = getPrevious.get(votePubkey) as
          | Record<string, string | number | null>
          | undefined;
        if (!previous || previous.status === "inactive") continue;
        const alert = {
          votePubkey,
          nodePubkey: String(previous.node_pubkey),
          field: "validator_status" as const,
          previousValue: String(previous.status),
          newValue: "inactive",
          detectedAt
        };
        const result = insertAlert.run(alert);
        alerts.push({ id: Number(result.lastInsertRowid), ...alert });
        insertHistory.run({
          votePubkey,
          nodePubkey: previous.node_pubkey,
          status: "inactive",
          eventType: "status_change",
          inflationCommissionBps: previous.inflation_commission_bps,
          blockRevenueCommissionBps: previous.block_revenue_commission_bps,
          inflationCollector: previous.inflation_collector,
          blockRevenueCollector: previous.block_revenue_collector,
          commissionSource: previous.commission_source,
          slot: String(slot),
          recordedAt: detectedAt
        });
        markInactive.run(votePubkey);
      }
      insertMetadata.run("last_successful_sync_at", detectedAt);
      insertMetadata.run("current_slot", String(slot));
      insertMetadata.run("current_epoch", String(epoch));
      insertMetadata.run("validator_count", String(snapshots.length));
    });

    transaction();
    return alerts;
  }

  listValidators(): ValidatorSnapshot[] {
    return this.db.prepare(`
      SELECT
        vote_pubkey AS votePubkey,
        node_pubkey AS nodePubkey,
        vote_state_version AS voteStateVersion,
        commission_source AS commissionSource,
        status,
        active_stake_lamports AS activeStakeLamports,
        inflation_commission_bps AS inflationCommissionBps,
        block_revenue_commission_bps AS blockRevenueCommissionBps,
        inflation_collector AS inflationCollector,
        block_revenue_collector AS blockRevenueCollector,
        root_slot AS rootSlot,
        last_vote AS lastVote,
        commission_score AS commissionScore,
        updated_at AS updatedAt
      FROM validators
      ORDER BY CAST(active_stake_lamports AS INTEGER) DESC
    `).all() as ValidatorSnapshot[];
  }

  getValidator(votePubkey: string): ValidatorSnapshot | null {
    const result = this.db.prepare(`
      SELECT
        vote_pubkey AS votePubkey,
        node_pubkey AS nodePubkey,
        vote_state_version AS voteStateVersion,
        commission_source AS commissionSource,
        status,
        active_stake_lamports AS activeStakeLamports,
        inflation_commission_bps AS inflationCommissionBps,
        block_revenue_commission_bps AS blockRevenueCommissionBps,
        inflation_collector AS inflationCollector,
        block_revenue_collector AS blockRevenueCollector,
        root_slot AS rootSlot,
        last_vote AS lastVote,
        commission_score AS commissionScore,
        updated_at AS updatedAt
      FROM validators WHERE vote_pubkey = ?
    `).get(votePubkey) as ValidatorSnapshot | undefined;
    return result ?? null;
  }

  listValidatorHistory(votePubkey: string, limit = 100): ValidatorHistoryEntry[] {
    return this.db.prepare(`
      SELECT
        id,
        vote_pubkey AS votePubkey,
        node_pubkey AS nodePubkey,
        status,
        event_type AS eventType,
        inflation_commission_bps AS inflationCommissionBps,
        block_revenue_commission_bps AS blockRevenueCommissionBps,
        inflation_collector AS inflationCollector,
        block_revenue_collector AS blockRevenueCollector,
        commission_source AS commissionSource,
        slot,
        recorded_at AS recordedAt
      FROM validator_history
      WHERE vote_pubkey = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(votePubkey, limit) as ValidatorHistoryEntry[];
  }

  getValidatorHistoryCount(votePubkey: string): number {
    const result = this.db.prepare(
      "SELECT COUNT(*) AS count FROM validator_history WHERE vote_pubkey = ?"
    ).get(votePubkey) as { count: number };
    return result.count;
  }

  listAlerts(limit = 100, offset = 0, votePubkeys?: string[]): ValidatorAlert[] {
    const filter = votePubkeys?.length
      ? `WHERE vote_pubkey IN (${votePubkeys.map(() => "?").join(",")})`
      : votePubkeys ? "WHERE 1 = 0" : "";
    return this.db.prepare(`
      SELECT
        id,
        vote_pubkey AS votePubkey,
        node_pubkey AS nodePubkey,
        field,
        previous_value AS previousValue,
        new_value AS newValue,
        detected_at AS detectedAt
      FROM alerts ${filter} ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...(votePubkeys ?? []), limit, offset) as ValidatorAlert[];
  }

  getAlertCount(votePubkeys?: string[]): number {
    const filter = votePubkeys?.length
      ? `WHERE vote_pubkey IN (${votePubkeys.map(() => "?").join(",")})`
      : votePubkeys ? "WHERE 1 = 0" : "";
    const result = this.db.prepare(`SELECT COUNT(*) AS count FROM alerts ${filter}`).get(
      ...(votePubkeys ?? [])
    ) as {
      count: number;
    };
    return result.count;
  }

  listAlertsAfter(afterId: number, limit: number): ValidatorAlert[] {
    return this.db.prepare(`
      SELECT
        id,
        vote_pubkey AS votePubkey,
        node_pubkey AS nodePubkey,
        field,
        previous_value AS previousValue,
        new_value AS newValue,
        detected_at AS detectedAt
      FROM alerts WHERE id > ? ORDER BY id ASC LIMIT ?
    `).all(afterId, limit) as ValidatorAlert[];
  }

  getLatestAlertId(): number {
    const result = this.db.prepare("SELECT MAX(id) AS id FROM alerts").get() as {
      id: number | null;
    };
    return result.id ?? 0;
  }

  getMetadata(key: string): string | null {
    const result = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return result?.value ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, value);
  }

  getStatus(): Record<string, string | null> {
    const rows = this.db.prepare("SELECT key, value FROM metadata").all() as Array<{
      key: string;
      value: string;
    }>;
    const metadata = new Map(rows.map(({ key, value }) => [key, value]));
    return {
      lastSuccessfulSyncAt: metadata.get("last_successful_sync_at") ?? null,
      currentSlot: metadata.get("current_slot") ?? null,
      currentEpoch: metadata.get("current_epoch") ?? null,
      validatorCount: metadata.get("validator_count") ?? "0"
    };
  }

  close(): void {
    this.db.close();
  }
}

function columnName(property: keyof ValidatorSnapshot): string {
  return property.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function historyEvents(
  previous: Record<string, string | number | null>,
  current: ValidatorSnapshot,
  changedFields: AlertField[]
): HistoryEventType[] {
  const configurationChanged = changedFields.some((field) =>
    field !== "validator_status"
  );
  const statusChanged = changedFields.includes("validator_status");
  const identityChanged = String(previous.node_pubkey) !== current.nodePubkey;
  const sourceChanged =
    previous.commission_source !== current.commissionSource;
  const events: HistoryEventType[] = [];

  if (configurationChanged && statusChanged) {
    events.push("configuration_and_status_change");
  } else if (configurationChanged) {
    events.push("configuration_change");
  } else if (statusChanged) {
    events.push("status_change");
  }
  if (identityChanged) events.push("identity_change");
  if (sourceChanged) events.push("source_change");
  return events;
}
