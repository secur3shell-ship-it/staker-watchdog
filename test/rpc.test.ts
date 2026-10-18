import assert from "node:assert/strict";
import test from "node:test";
import { SolanaRpc } from "../src/rpc.js";
import { VOTE_PROGRAM_ID } from "../src/vote-account.js";
import { mockRpc, pubkey, voteStateV4, voteStateWithTag } from "./helpers.js";

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
  const voteState = voteStateV4({
    inflationCommissionBps: 750,
    blockRevenueCommissionBps: 2500
  });
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
  const { details } = await rpc.getVoteStateDetails([
    "Vote111111111111111111111111111111111111111"
  ]);
  assert.equal(
    details.get("Vote111111111111111111111111111111111111111")?.blockRevenueCommissionBps,
    2500
  );
});

test("reports unreadable accounts individually instead of failing the batch", async () => {
  const good = pubkey(1);
  const rpc = mockRpc(() => [
    { vote: good, node: pubkey(2), account: voteStateV4() },
    { vote: pubkey(3), node: pubkey(4), account: null },
    { vote: pubkey(5), node: pubkey(6), account: voteStateV4(), owner: pubkey(9) },
    { vote: pubkey(7), node: pubkey(8), account: voteStateWithTag(9) }
  ]);
  const { details, failures } = await rpc.getVoteStateDetails([
    good, pubkey(3), pubkey(5), pubkey(7)
  ]);
  assert.deepEqual([...details.keys()], [good]);
  assert.equal(failures.get(pubkey(3)), "account not found");
  assert.match(failures.get(pubkey(5)) ?? "", /not owned by the vote program/);
  assert.match(failures.get(pubkey(7)) ?? "", /Unsupported vote account state tag 9/);
});

test("still fails the sync when the RPC envelope itself is malformed", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [] } });
  const rpc = new SolanaRpc("https://rpc.invalid", async () => new Response(body));
  await assert.rejects(rpc.getVoteStateDetails([pubkey(1)]), /invalid getMultipleAccounts/);
});
