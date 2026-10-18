import { identifyVoteState, VOTE_PROGRAM_ID } from "./vote-account.js";
import type { ValidatorRpcEntry, VoteAccountDetails } from "./types.js";
import JSONbig from "json-bigint";

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface RpcAccountInfo {
  owner: string;
  data: [string, string];
}

interface RpcAccountBatch {
  context: { slot: number | string };
  value: (RpcAccountInfo | null)[];
}

interface RpcVoteAccounts {
  current: ValidatorRpcEntry[];
  delinquent: ValidatorRpcEntry[];
}

interface RpcEpochInfo {
  epoch: number;
}

export class SolanaRpc {
  private requestId = 0;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getVoteAccounts(): Promise<RpcVoteAccounts> {
    const result = await this.request<RpcVoteAccounts>("getVoteAccounts", [
      { commitment: "finalized" }
    ]);
    if (
      !result ||
      !Array.isArray(result.current) ||
      !Array.isArray(result.delinquent)
    ) {
      throw new Error("RPC returned an invalid getVoteAccounts response");
    }
    return result;
  }

  async getSlot(): Promise<number> {
    const result = await this.request<number | string>("getSlot", [{ commitment: "finalized" }]);
    const slot = Number(result);
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new Error("RPC returned an invalid finalized slot");
    }
    return slot;
  }

  async getEpoch(): Promise<number> {
    const result = await this.request<{ epoch: number | string }>("getEpochInfo", [
      { commitment: "finalized" }
    ]);
    const epoch = Number(result?.epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error("RPC returned an invalid finalized epoch");
    }
    return epoch;
  }

  async getVoteStateDetails(
    votePubkeys: string[]
  ): Promise<Map<string, VoteAccountDetails>> {
    const details = new Map<string, VoteAccountDetails>();
    for (let offset = 0; offset < votePubkeys.length; offset += 100) {
      const batch = votePubkeys.slice(offset, offset + 100);
      const result = await this.request<RpcAccountBatch>(
        "getMultipleAccounts",
        [batch, { commitment: "finalized", encoding: "base64" }]
      );
      if (!Array.isArray(result?.value) || result.value.length !== batch.length) {
        throw new Error("RPC returned an invalid getMultipleAccounts response");
      }

      result.value.forEach((account, index) => {
        if (!account) return;
        const votePubkey = batch[index];
        if (!votePubkey) return;
        if (account.owner !== VOTE_PROGRAM_ID) {
          throw new Error(`Vote account ${votePubkey} is not owned by the vote program`);
        }
        if (
          !Array.isArray(account.data) ||
          account.data[1] !== "base64" ||
          typeof account.data[0] !== "string"
        ) {
          throw new Error(`RPC returned malformed account data for ${votePubkey}`);
        }
        const parsed = identifyVoteState(Buffer.from(account.data[0], "base64"));
        details.set(votePubkey, parsed);
      });
    }
    return details;
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method,
        params
      }),
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      throw new Error(`Solana RPC ${method} failed with HTTP ${response.status}`);
    }

    const payload = JSONbig({ storeAsString: true }).parse(
      await response.text()
    ) as RpcResponse<T>;
    if (payload.error) {
      throw new Error(`Solana RPC ${method} error ${payload.error.code}: ${payload.error.message}`);
    }
    if (!("result" in payload)) {
      throw new Error(`Solana RPC ${method} response did not include a result`);
    }
    return payload.result as T;
  }
}
