import bs58 from "bs58";
import { SolanaRpc } from "../src/rpc.js";
import { VOTE_PROGRAM_ID } from "../src/vote-account.js";

/** Deterministic base58 public key made of one repeated byte. */
export const pubkey = (byte: number): string => bs58.encode(Buffer.alloc(32, byte));

/** On-chain tag 3 (VoteStateVersions::V4) with the given fixed fields. */
export function voteStateV4(fields: {
  node?: string;
  inflationCollector?: string;
  blockRevenueCollector?: string;
  inflationCommissionBps?: number;
  blockRevenueCommissionBps?: number;
} = {}): Buffer {
  const data = Buffer.alloc(144);
  data.writeUInt32LE(3, 0);
  if (fields.node) Buffer.from(bs58.decode(fields.node)).copy(data, 4);
  if (fields.inflationCollector) Buffer.from(bs58.decode(fields.inflationCollector)).copy(data, 68);
  if (fields.blockRevenueCollector) {
    Buffer.from(bs58.decode(fields.blockRevenueCollector)).copy(data, 100);
  }
  data.writeUInt16LE(fields.inflationCommissionBps ?? 500, 132);
  data.writeUInt16LE(fields.blockRevenueCommissionBps ?? 10_000, 134);
  return data;
}

export function voteStateWithTag(tag: number): Buffer {
  const data = Buffer.alloc(144);
  data.writeUInt32LE(tag, 0);
  return data;
}

export interface MockValidator {
  vote: string;
  node: string;
  commission?: number;
  delinquent?: boolean;
  /** Account data; null simulates a missing account. */
  account: Buffer | null;
  owner?: string;
}

/** SolanaRpc backed by a mutable in-memory cluster. */
export function mockRpc(cluster: () => MockValidator[]): SolanaRpc {
  return new SolanaRpc("https://rpc.invalid", async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const validators = cluster();
    const entry = (validator: MockValidator) => ({
      votePubkey: validator.vote,
      nodePubkey: validator.node,
      activatedStake: 1_000_000_000,
      commission: validator.commission ?? 5,
      rootSlot: 99,
      lastVote: 100,
      epochVoteAccount: true
    });
    let result: unknown;
    if (request.method === "getVoteAccounts") {
      result = {
        current: validators.filter((validator) => !validator.delinquent).map(entry),
        delinquent: validators.filter((validator) => validator.delinquent).map(entry)
      };
    } else if (request.method === "getMultipleAccounts") {
      const keys = request.params[0] as string[];
      result = {
        context: { slot: 100 },
        value: keys.map((key) => {
          const validator = validators.find(({ vote }) => vote === key);
          if (!validator?.account) return null;
          return {
            owner: validator.owner ?? VOTE_PROGRAM_ID,
            data: [validator.account.toString("base64"), "base64"]
          };
        })
      };
    } else if (request.method === "getSlot") {
      result = 100;
    } else {
      result = { epoch: 4 };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
}
