/**
 * The minimal TON RPC surface the wallet + payer need. Inject a custom one for
 * tests (so nothing touches the network or moves funds); use `ToncenterRpc` in
 * production.
 */

import { Address, beginCell } from "@ton/core";
import { TonClient } from "@ton/ton";

/**
 * The minimal TON RPC surface the wallet + payer depend on. Implement it (or
 * use {@link ToncenterRpc}) to read balances/seqno, resolve jetton wallets, and
 * broadcast. Inject a mock in tests so nothing touches the network or moves funds.
 */
export interface TonRpc {
  /** Account TON balance, in nanoTON. */
  getBalance(address: string): Promise<bigint>;
  /** The wallet's current seqno (0 if the wallet contract isn't deployed yet). */
  getSeqno(address: string): Promise<number>;
  /** Resolve an owner's jetton wallet address from the jetton master (get_wallet_address). */
  resolveJettonWallet(owner: string, jettonMaster: string): Promise<string>;
  /** A jetton wallet's token balance, in the jetton's smallest unit (get_wallet_data). */
  getJettonBalance(jettonWallet: string): Promise<bigint>;
  /** Broadcast a serialized external-message BoC. */
  sendBoc(boc: Uint8Array): Promise<void>;
}

/** Options for {@link ToncenterRpc}. */
export interface ToncenterRpcOptions {
  /** JSON-RPC endpoint, e.g. `https://toncenter.com/api/v2/jsonRPC` (or a testnet URL). */
  endpoint: string;
  /** toncenter API key (recommended to avoid tight rate limits). */
  apiKey?: string;
}

/**
 * Default {@link TonRpc} backed by toncenter via `@ton/ton`'s `TonClient`.
 *
 * @example
 * ```ts
 * const rpc = new ToncenterRpc({
 *   endpoint: "https://toncenter.com/api/v2/jsonRPC",
 *   apiKey: process.env.TONCENTER_KEY,
 * });
 * ```
 */
export class ToncenterRpc implements TonRpc {
  private readonly client: TonClient;

  /** @param opts - the {@link ToncenterRpcOptions} (endpoint + optional API key) */
  constructor(opts: ToncenterRpcOptions) {
    this.client = new TonClient(opts.apiKey ? { endpoint: opts.endpoint, apiKey: opts.apiKey } : { endpoint: opts.endpoint });
  }

  /** {@inheritDoc TonRpc.getBalance} */
  getBalance(address: string): Promise<bigint> {
    return this.client.getBalance(Address.parse(address));
  }

  /** {@inheritDoc TonRpc.getSeqno} */
  async getSeqno(address: string): Promise<number> {
    const addr = Address.parse(address);
    if (!(await this.client.isContractDeployed(addr))) return 0;
    const res = await this.client.runMethod(addr, "seqno");
    return res.stack.readNumber();
  }

  /** {@inheritDoc TonRpc.resolveJettonWallet} */
  async resolveJettonWallet(owner: string, jettonMaster: string): Promise<string> {
    const res = await this.client.runMethod(Address.parse(jettonMaster), "get_wallet_address", [
      { type: "slice", cell: beginCell().storeAddress(Address.parse(owner)).endCell() },
    ]);
    return res.stack.readAddress().toString();
  }

  /** {@inheritDoc TonRpc.getJettonBalance} */
  async getJettonBalance(jettonWallet: string): Promise<bigint> {
    const res = await this.client.runMethod(Address.parse(jettonWallet), "get_wallet_data");
    return res.stack.readBigNumber();
  }

  /** {@inheritDoc TonRpc.sendBoc} */
  async sendBoc(boc: Uint8Array): Promise<void> {
    await this.client.sendFile(Buffer.from(boc));
  }
}
