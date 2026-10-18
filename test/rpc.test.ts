import assert from "node:assert/strict";
import test from "node:test";
import { SolanaRpc } from "../src/rpc.js";
import { VOTE_PROGRAM_ID } from "../src/vote-account.js";

test("preserves u64 stake values from RPC JSON without floating-point loss", async () => {
  const body = `{
    "jsonrpc":"2.0","id":1,"result":{
      "current":[{
        "votePubkey":"vote",
        "nodePubkey":"node",
        "activatedStake":12345678901234567,
        "commission":5,
        "rootSlot":987654321,
        "lastVote":987654322,
        "epochVoteAccount":true
      }],
      "delinquent":[]
    }
  }`;
  const rpc = new SolanaRpc("https://rpc.invalid", async () => new Response(body));
  const result = await rpc.getVoteAccounts();
  assert.equal(result.current[0]?.activatedStake, "12345678901234567");
});

test("reads account data from the getMultipleAccounts result envelope", async () => {
  const voteState = Buffer.alloc(144);
  voteState.writeUInt32LE(4, 0);
  voteState.writeUInt16LE(750, 132);
  voteState.writeUInt16LE(2500, 134);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      context: { slot: 42 },
      value: [{
        owner: VOTE_PROGRAM_ID,
        data: [voteState.toString("base64"), "base64"]
      }]
    }
  });
  const rpc = new SolanaRpc("https://rpc.invalid", async () => new Response(body));
  const details = await rpc.getVoteStateDetails([
    "Vote111111111111111111111111111111111111111"
  ]);
  assert.equal(
    details.get("Vote111111111111111111111111111111111111111")?.blockRevenueCommissionBps,
    2500
  );
});
