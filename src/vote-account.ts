import bs58 from "bs58";
import type { VoteAccountDetails } from "./types.js";

export const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";
export const VOTE_STATE_V4 = 4;
const V4_HEADER_SIZE = 144;

// Vote accounts hold a bincode-serialized `VoteStateVersions` enum, so the
// leading u32 is the enum variant index, not the layout's version number:
// 0 = V0_23_5, 1 = V1_14_11, 2 = V3, 3 = V4.
const LAYOUT_VERSION_BY_TAG: ReadonlyMap<number, number> = new Map([
  [0, 0],
  [1, 1],
  [2, 3],
  [3, VOTE_STATE_V4]
]);
export const LEGACY_VOTE_STATE_VERSIONS: ReadonlySet<number> = new Set([0, 1, 3]);

export function readVoteStateTag(data: Uint8Array): number {
  if (data.byteLength < 4) {
    throw new Error("Vote account data is too short to contain a version tag");
  }
  return Buffer.from(data).readUInt32LE(0);
}

export function readVoteStateVersion(data: Uint8Array): number {
  const tag = readVoteStateTag(data);
  const version = LAYOUT_VERSION_BY_TAG.get(tag);
  if (version === undefined) {
    throw new Error(`Unsupported vote account state tag ${tag}`);
  }
  return version;
}

export function decodeVoteStateV4(data: Uint8Array): VoteAccountDetails | null {
  const buffer = Buffer.from(data);
  if (readVoteStateTag(data) !== 3) {
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
    version: VOTE_STATE_V4,
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
  return {
    version,
    inflationCommissionBps: null,
    blockRevenueCommissionBps: null,
    inflationCollector: null,
    blockRevenueCollector: null
  };
}
