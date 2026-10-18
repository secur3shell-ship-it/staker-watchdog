import assert from "node:assert/strict";
import test from "node:test";
import { ValidatorMonitor } from "../src/monitor.js";
import { SolanaRpc } from "../src/rpc.js";
import { WatchdogStore } from "../src/store.js";
import { VOTE_PROGRAM_ID } from "../src/vote-account.js";

test("publishes committed syncs and newly detected changes", async () => {
  let inflationCommissionBps = 500;
  let slot = 100;
  const voteAccountData = (): string => {
    const data = Buffer.alloc(144);
    data.writeUInt32LE(4, 0);
    data.writeUInt16LE(inflationCommissionBps, 132);
    data.writeUInt16LE(2500, 134);
    return data.toString("base64");
  };
  const rpc = new SolanaRpc("https://rpc.invalid", async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    const result = request.method === "getVoteAccounts"
      ? {
          current: [{
            votePubkey: "vote-address",
            nodePubkey: "node-address",
            activatedStake: 12345678901234567,
            commission: 5,
            rootSlot: 99,
            lastVote: 100,
            epochVoteAccount: true
          }],
          delinquent: []
        }
      : request.method === "getMultipleAccounts"
        ? {
            context: { slot },
            value: [{
              owner: VOTE_PROGRAM_ID,
              data: [voteAccountData(), "base64"]
            }]
          }
        : request.method === "getSlot"
          ? slot
          : { epoch: 4 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  const store = new WatchdogStore(":memory:");
  const updates: Array<{
    slot: number;
    epoch: number;
    validatorCount: number;
    alerts: Array<{ field: string; previousValue: string | null; newValue: string | null }>;
  }> = [];
  const monitor = new ValidatorMonitor(rpc, store, undefined, (update) => {
    updates.push(update);
  });

  try {
    await monitor.sync();
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.validatorCount, 1);
    assert.equal(updates[0]?.alerts.length, 0);
    assert.equal(store.listValidatorHistory("vote-address").length, 1);

    inflationCommissionBps = 750;
    slot = 101;
    await monitor.sync();
    assert.equal(updates.length, 2);
    assert.deepEqual(
      updates[1]?.alerts.map(({ field, previousValue, newValue }) => [
        field,
        previousValue,
        newValue
      ]),
      [["inflation_commission", "500", "750"]]
    );
    assert.equal(updates[1]?.slot, 101);
    assert.equal(store.listValidatorHistory("vote-address").length, 2);
  } finally {
    store.close();
  }
});
