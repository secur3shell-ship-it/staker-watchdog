import assert from "node:assert/strict";
import test from "node:test";
import { ValidatorMonitor, type MonitorUpdate } from "../src/monitor.js";
import { WatchdogStore } from "../src/store.js";
import { mockRpc, pubkey, voteStateV4, voteStateWithTag, type MockValidator } from "./helpers.js";

function setup(initial: MockValidator[]) {
  let cluster = initial;
  const store = new WatchdogStore(":memory:");
  const updates: MonitorUpdate[] = [];
  const monitor = new ValidatorMonitor(mockRpc(() => cluster), store, (update) => {
    updates.push(update);
  });
  return {
    store,
    updates,
    monitor,
    setCluster: (next: MockValidator[]) => { cluster = next; }
  };
}

const alertTuples = (update: MonitorUpdate | undefined) =>
  update?.alerts.map(({ field, previousValue, newValue }) => [field, previousValue, newValue]);

test("publishes committed syncs and newly detected changes", async () => {
  const vote = pubkey(1);
  const node = pubkey(2);
  const { store, updates, monitor, setCluster } = setup([
    { vote, node, account: voteStateV4({ node, inflationCommissionBps: 500 }) }
  ]);
  try {
    await monitor.sync();
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.validatorCount, 1);
    assert.equal(updates[0]?.alerts.length, 0);
    assert.equal(store.listValidatorHistory(vote).length, 1);

    setCluster([{ vote, node, account: voteStateV4({ node, inflationCommissionBps: 750 }) }]);
    await monitor.sync();
    assert.deepEqual(alertTuples(updates[1]), [["inflation_commission", "500", "750"]]);
    assert.equal(store.listValidatorHistory(vote).length, 2);
  } finally {
    store.close();
  }
});

test("reads on-chain V4 block-revenue commission and collectors, not legacy defaults", async () => {
  const vote = pubkey(1);
  const node = pubkey(2);
  const { store, updates, monitor, setCluster } = setup([
    { vote, node, account: voteStateV4({ node, blockRevenueCollector: node }) }
  ]);
  try {
    await monitor.sync();
    const baseline = store.getValidator(vote);
    assert.equal(baseline?.commissionSource, "vote_state_v4");
    assert.equal(baseline?.voteStateVersion, 4);

    setCluster([{
      vote,
      node,
      account: voteStateV4({
        node,
        blockRevenueCommissionBps: 500,
        blockRevenueCollector: pubkey(77)
      })
    }]);
    await monitor.sync();
    const updated = store.getValidator(vote);
    assert.equal(updated?.blockRevenueCommissionBps, 500);
    assert.equal(updated?.blockRevenueCollector, pubkey(77));
    assert.deepEqual(alertTuples(updates[1]), [
      ["block_revenue_commission", "10000", "500"],
      ["block_revenue_collector", node, pubkey(77)]
    ]);
  } finally {
    store.close();
  }
});

test("one unreadable account does not halt monitoring of the others", async () => {
  const { store, updates, monitor, setCluster } = setup([
    { vote: pubkey(1), node: pubkey(2), account: voteStateV4({ inflationCommissionBps: 500 }) },
    { vote: pubkey(3), node: pubkey(4), account: voteStateV4({ inflationCommissionBps: 0 }) }
  ]);
  try {
    await monitor.sync();
    setCluster([
      { vote: pubkey(1), node: pubkey(2), account: voteStateV4({ inflationCommissionBps: 800 }) },
      { vote: pubkey(3), node: pubkey(4), account: voteStateWithTag(9) }
    ]);
    await monitor.sync();
    assert.equal(updates.length, 2);
    assert.deepEqual(alertTuples(updates[1]), [["inflation_commission", "500", "800"]]);
    // The unreadable account keeps its last decoded configuration.
    assert.equal(store.getValidator(pubkey(3))?.inflationCommissionBps, 0);
    assert.equal(store.getValidator(pubkey(3))?.commissionSource, "vote_state_v4");
  } finally {
    store.close();
  }
});

test("a change made while an account was unreadable is still detected", async () => {
  const vote = pubkey(1);
  const node = pubkey(2);
  const { store, updates, monitor, setCluster } = setup([
    { vote, node, account: voteStateV4({ blockRevenueCommissionBps: 1000 }) }
  ]);
  try {
    await monitor.sync();
    setCluster([{ vote, node, account: null }]);
    await monitor.sync();
    assert.equal(store.getValidator(vote)?.blockRevenueCommissionBps, 1000);
    assert.deepEqual(alertTuples(updates[1]), []);

    setCluster([{ vote, node, account: voteStateV4({ blockRevenueCommissionBps: 2500 }) }]);
    await monitor.sync();
    assert.deepEqual(alertTuples(updates[2]), [["block_revenue_commission", "1000", "2500"]]);
  } finally {
    store.close();
  }
});

test("validators that leave getVoteAccounts are marked inactive and can return", async () => {
  const keep = { vote: pubkey(1), node: pubkey(2), account: voteStateV4() };
  const leaving = { vote: pubkey(3), node: pubkey(4), account: voteStateV4() };
  const { store, updates, monitor, setCluster } = setup([keep, leaving]);
  try {
    await monitor.sync();
    setCluster([keep]);
    await monitor.sync();
    assert.equal(store.getValidator(leaving.vote)?.status, "inactive");
    assert.deepEqual(alertTuples(updates[1]), [["validator_status", "current", "inactive"]]);
    assert.equal(store.listValidatorHistory(leaving.vote)[0]?.status, "inactive");

    await monitor.sync();
    assert.deepEqual(alertTuples(updates[2]), [], "inactive is only alerted once");

    setCluster([keep, leaving]);
    await monitor.sync();
    assert.deepEqual(alertTuples(updates[3]), [["validator_status", "inactive", "current"]]);
  } finally {
    store.close();
  }
});

test("a suspiciously small RPC response does not mark validators inactive", async () => {
  const cluster = Array.from({ length: 30 }, (_, index) => ({
    vote: pubkey(index + 1),
    node: pubkey(index + 101),
    account: voteStateV4()
  }));
  const { store, updates, monitor, setCluster } = setup(cluster);
  try {
    await monitor.sync();
    setCluster(cluster.slice(0, 5));
    await monitor.sync();
    assert.deepEqual(alertTuples(updates[1]), []);
    assert.equal(store.getValidator(pubkey(30))?.status, "current");
  } finally {
    store.close();
  }
});
