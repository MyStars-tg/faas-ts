/**
 * `TonWallet` — generate or import a TON wallet (WalletContractV4), in memory only.
 *
 * KEY CUSTODY: this class holds the secret key/mnemonic ONLY in process memory.
 * It never writes them to disk, never logs them, and never sends them anywhere.
 * `generate()` returns the mnemonic exactly once — YOU are responsible for
 * storing it securely. Fund the wallet's `address`, then pay invoices with
 * `OrderPayer`.
 *
 * Only WalletContractV4 is supported for now (the version `generate()` produces).
 * Importing a non-V4 wallet by mnemonic would derive a different address — a
 * future `version` option can add V5R1 without breaking this API.
 */

import type { Cell, MessageRelaxed, SendMode, StateInit } from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate, type KeyPair } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import type { TonRpc } from "./rpc.js";

/** Base error for the wallet module. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
/** The wallet doesn't hold enough TON / jetton balance to cover a payment. */
export class InsufficientBalanceError extends WalletError {}

/** Arguments for {@link TonWallet.createTransfer} — the unsigned pieces of a wallet-v4 transfer. */
export interface CreateTransferArgs {
  /** The wallet's current seqno (fetch via {@link TonWallet.getSeqno}); 0 deploys the contract. */
  seqno: number;
  /** The internal messages to send in this transfer. */
  messages: MessageRelaxed[];
  /** The send mode flags (`@ton/core` `SendMode`). */
  sendMode: SendMode;
  /** Transfer validity window as a unix-seconds expiry; the wallet rejects it after this. */
  timeout?: number;
}

/**
 * An in-memory TON wallet (WalletContractV4). Construct via {@link TonWallet.generate} /
 * {@link TonWallet.fromMnemonic} / {@link TonWallet.fromKeyPair}. Keys never leave memory and are
 * redacted from serialization. See the module overview for the custody stance.
 */
export class TonWallet {
  /** The in-memory key pair. Treat `secretKey` as a secret — never log or persist it. */
  readonly keyPair!: KeyPair;
  private readonly contract!: WalletContractV4;

  private constructor(keyPair: KeyPair) {
    const contract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    // Non-enumerable so `JSON.stringify(wallet)` / structured loggers / Sentry never
    // serialize the secret key. `toJSON` + the custom inspect below redact it too.
    Object.defineProperty(this, "keyPair", { value: keyPair, enumerable: false });
    Object.defineProperty(this, "contract", { value: contract, enumerable: false });
  }

  /** Redacted serialization — NEVER exposes the secret key. */
  toJSON(): { address: string; publicKey: string } {
    return { address: this.address, publicKey: this.keyPair.publicKey.toString("hex") };
  }

  /** Redacted console.log/util.inspect output. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `TonWallet<${this.address}>`;
  }

  /**
   * Generate a NEW wallet. Returns the 24-word mnemonic ONCE — store it securely;
   * it is never persisted.
   *
   * @returns the in-memory `wallet` and its `mnemonic` (the only time you see it)
   * @example
   * ```ts
   * const { wallet, mnemonic } = await TonWallet.generate();
   * await secureVault.store(mnemonic);     // YOUR job — it is never written to disk by the SDK
   * console.log("fund this:", wallet.address);
   * ```
   */
  static async generate(): Promise<{ wallet: TonWallet; mnemonic: string[] }> {
    const mnemonic = await mnemonicNew();
    return { wallet: await TonWallet.fromMnemonic(mnemonic), mnemonic };
  }

  /** Import a wallet from its 24-word mnemonic. */
  static async fromMnemonic(words: string[]): Promise<TonWallet> {
    if (!(await mnemonicValidate(words))) throw new WalletError("invalid TON mnemonic");
    const keyPair = await mnemonicToPrivateKey(words);
    return new TonWallet(keyPair);
  }

  /** Import a wallet from a raw Ed25519 key pair. */
  static fromKeyPair(publicKey: Uint8Array, secretKey: Uint8Array): TonWallet {
    return new TonWallet({ publicKey: Buffer.from(publicKey), secretKey: Buffer.from(secretKey) });
  }

  /** Friendly, non-bounceable (`UQ…`) address — FUND THIS to pay invoices. */
  get address(): string {
    return this.contract.address.toString({ bounceable: false });
  }

  /** Raw `0:hex` address form. */
  get rawAddress(): string {
    return this.contract.address.toRawString();
  }

  /** @internal The contract's StateInit, needed for the first (deploying) transfer. */
  get init(): StateInit {
    return this.contract.init;
  }

  /** @internal The contract address as a TON `Address`. */
  get tonAddress() {
    return this.contract.address;
  }

  /** @internal Sign a transfer body. */
  createTransfer(args: CreateTransferArgs): Cell {
    return this.contract.createTransfer({ ...args, secretKey: this.keyPair.secretKey });
  }

  /**
   * This wallet's native TON balance.
   *
   * @param rpc - the RPC to query through
   * @returns the balance in nanoTON
   */
  getBalance(rpc: TonRpc): Promise<bigint> {
    return rpc.getBalance(this.address);
  }

  /**
   * This wallet's current sequence number.
   *
   * @param rpc - the RPC to query through
   * @returns the seqno (`0` when the wallet contract isn't deployed yet)
   */
  getSeqno(rpc: TonRpc): Promise<number> {
    return rpc.getSeqno(this.address);
  }

  /**
   * This wallet's balance of a given jetton (e.g. USDT).
   *
   * @param rpc - the RPC to query through
   * @param jettonMaster - the jetton master address (e.g. `DEFAULT_USDT_MASTER` from `@mystars-tg/faas-wallet`)
   * @returns the token balance in the jetton's smallest unit (micro-USDT for USDT)
   */
  async getJettonBalance(rpc: TonRpc, jettonMaster: string): Promise<bigint> {
    const jettonWallet = await rpc.resolveJettonWallet(this.address, jettonMaster);
    return rpc.getJettonBalance(jettonWallet);
  }
}
