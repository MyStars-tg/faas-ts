import { describe, it, expect } from "vitest";
import { TonWallet, WalletError } from "../src/wallet.js";
import type { TonRpc } from "../src/rpc.js";

function mockRpc(over: Partial<TonRpc> = {}): TonRpc {
  return {
    getBalance: () => Promise.resolve(0n),
    getSeqno: () => Promise.resolve(0),
    resolveJettonWallet: () => Promise.resolve("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"),
    getJettonBalance: () => Promise.resolve(0n),
    sendBoc: () => Promise.resolve(),
    ...over,
  };
}

describe("TonWallet", () => {
  it("generate() returns a 24-word mnemonic and a wallet with a UQ address", async () => {
    const { wallet, mnemonic } = await TonWallet.generate();
    expect(mnemonic).toHaveLength(24);
    expect(wallet.address).toMatch(/^UQ/);
    expect(wallet.rawAddress).toMatch(/^0:[0-9a-f]{64}$/);
  });

  it("fromMnemonic is deterministic (same words → same address)", async () => {
    const { mnemonic } = await TonWallet.generate();
    const a = await TonWallet.fromMnemonic(mnemonic);
    const b = await TonWallet.fromMnemonic(mnemonic);
    expect(a.address).toBe(b.address);
  });

  it("fromMnemonic throws on an invalid mnemonic", async () => {
    await expect(TonWallet.fromMnemonic(["not", "a", "valid", "mnemonic"])).rejects.toBeInstanceOf(WalletError);
  });

  it("fromKeyPair reconstructs the same address as the generating wallet", async () => {
    const { wallet } = await TonWallet.generate();
    const clone = TonWallet.fromKeyPair(wallet.keyPair.publicKey, wallet.keyPair.secretKey);
    expect(clone.address).toBe(wallet.address);
  });

  it("NEVER leaks the secret key via JSON.stringify or util.inspect", async () => {
    const { wallet } = await TonWallet.generate();
    const secretHex = wallet.keyPair.secretKey.toString("hex");
    const json = JSON.stringify(wallet);
    expect(json).not.toContain(secretHex);
    expect(json).not.toContain("secretKey");
    expect(JSON.parse(json)).toEqual({ address: wallet.address, publicKey: wallet.keyPair.publicKey.toString("hex") });
    // Logging the wallet (which uses util.inspect) must not dump the key either.
    const { inspect } = await import("node:util");
    expect(inspect(wallet)).not.toContain(secretHex);
  });

  it("reads balances through the injected rpc", async () => {
    const { wallet } = await TonWallet.generate();
    const rpc = mockRpc({ getBalance: () => Promise.resolve(5_000_000_000n), getSeqno: () => Promise.resolve(7) });
    expect(await wallet.getBalance(rpc)).toBe(5_000_000_000n);
    expect(await wallet.getSeqno(rpc)).toBe(7);
  });

  it("getJettonBalance resolves the jetton wallet then reads its balance", async () => {
    const { wallet } = await TonWallet.generate();
    let resolvedOwner = "";
    const rpc = mockRpc({
      resolveJettonWallet: (owner) => {
        resolvedOwner = owner;
        return Promise.resolve("EQjetton");
      },
      getJettonBalance: (jw) => Promise.resolve(jw === "EQjetton" ? 4_990_000n : 0n),
    });
    expect(await wallet.getJettonBalance(rpc, "EQmaster")).toBe(4_990_000n);
    expect(resolvedOwner).toBe(wallet.address);
  });
});
