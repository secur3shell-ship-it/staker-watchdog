import bs58 from "bs58";
import type { VoteAccountDetails } from "./types.js";

export const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";
const VOTE_STATE_V4 = 4;
const V4_HEADER_SIZE = 144;

export function readVoteStateVersion(data: Uint8Array): number {
  if (data.byteLength < 4) {
    throw new Error("Vote account data is too short to contain a version tag");
  }
  return Buffer.from(data).readUInt32LE(0);
}

export function decodeVoteStateV4(data: Uint8Array): VoteAccountDetails | null {
  const buffer = Buffer.from(data);
  const version = readVoteStateVersion(data);
  if (version !== VOTE_STATE_V4) {
    return null;
  }
  if (buffer.byteLength < V4_HEADER_SIZE) {
    throw new Error(`VoteStateV4 account data is truncated (${buffer.byteLength} bytes)`);
  }

  const inflationCollector = bs58.encode(buffer.subarray(68, 100));
  const blockRevenueCollector = bs58.encode(buffer.subarray(100, 132));
  const inflationCommissionBps = buffer.readUInt16LE(132);
  const blockRevenueCommissionBps = buffer.readUInt16LE(134);

  return {
    version,
    inflationCommissionBps,
    blockRevenueCommissionBps,
    inflationCollector,
    blockRevenueCollector
  };
}

export function identifyVoteState(data: Uint8Array): VoteAccountDetails {
  const version = readVoteStateVersion(data);
  const v4 = decodeVoteStateV4(data);
  if (v4) return v4;
  if (version >= 1 && version <= 3) {
    return {
      version,
      inflationCommissionBps: null,
      blockRevenueCommissionBps: null,
      inflationCollector: null,
      blockRevenueCollector: null
    };
  }
  throw new Error(`Unsupported vote account state version ${version}`);
}
