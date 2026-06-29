import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, SDK_VERSION } from "../src/version.js";
import { MyStarsClient } from "../src/client.js";
import {
  TERMINAL_STATUSES,
  WEBHOOK_TERMINAL,
  INITIAL_ORDER_STATUS,
  CANCELLABLE_STATUSES,
} from "../src/types.js";

/** The 8 client operationIds — mirrors faasSpec.ts EXPECTED_FAAS_OPERATION_IDS. */
const EXPECTED_OPERATIONS = [
  "createOrder",
  "getOrder",
  "listOrders",
  "cancelOrder",
  "checkRecipient",
  "getPricing",
  "listCurrencies",
  "listProducts",
] as const;

function contractPath(name: string): string {
  return fileURLToPath(new URL(`../../../contract/${name}`, import.meta.url));
}

describe("contract version", () => {
  it("CONTRACT_VERSION and SDK_VERSION are valid semver-ish strings", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("CONTRACT_VERSION matches contract/CONTRACT_VERSION", () => {
    const p = contractPath("CONTRACT_VERSION");
    if (!existsSync(p)) return; // mirrored standalone repo — the upstream CI guard is authoritative
    expect(readFileSync(p, "utf8").trim()).toBe(CONTRACT_VERSION);
  });
});

describe("status machine fixture", () => {
  it("the SDK's TERMINAL_STATUSES matches contract/status-machine.json", () => {
    const p = contractPath("status-machine.json");
    if (!existsSync(p)) return;
    const fixture = JSON.parse(readFileSync(p, "utf8")) as { statuses: string[]; terminal: string[] };
    expect(fixture.statuses).toHaveLength(15);
    expect(new Set(fixture.terminal)).toEqual(TERMINAL_STATUSES);
    // Every terminal status is also in the full status list.
    for (const t of fixture.terminal) expect(fixture.statuses).toContain(t);
  });

  it("the fixture pins the same contract version", () => {
    const p = contractPath("status-machine.json");
    if (!existsSync(p)) return;
    const fixture = JSON.parse(readFileSync(p, "utf8")) as { contract_version: string };
    expect(fixture.contract_version).toBe(CONTRACT_VERSION);
  });

  it("the SDK's WEBHOOK_TERMINAL matches the fixture's webhook_terminal", () => {
    const p = contractPath("status-machine.json");
    if (!existsSync(p)) return;
    const fixture = JSON.parse(readFileSync(p, "utf8")) as { webhook_terminal: string[] };
    expect(new Set(fixture.webhook_terminal)).toEqual(WEBHOOK_TERMINAL);
    // Every webhook-terminal status is also a real (terminal) status.
    for (const s of fixture.webhook_terminal) expect(TERMINAL_STATUSES.has(s as never)).toBe(true);
  });

  it("the SDK's INITIAL_ORDER_STATUS matches the fixture's initial_on_create", () => {
    const p = contractPath("status-machine.json");
    if (!existsSync(p)) return;
    const fixture = JSON.parse(readFileSync(p, "utf8")) as { initial_on_create: string; statuses: string[] };
    expect(fixture.initial_on_create).toBe(INITIAL_ORDER_STATUS);
    expect(fixture.statuses).toContain(INITIAL_ORDER_STATUS);
  });

  it("the SDK's CANCELLABLE_STATUSES matches the fixture's cancellable_from", () => {
    const p = contractPath("status-machine.json");
    if (!existsSync(p)) return;
    const fixture = JSON.parse(readFileSync(p, "utf8")) as { cancellable_from: string[] };
    expect(new Set(fixture.cancellable_from)).toEqual(CANCELLABLE_STATUSES);
  });
});

describe("contract fixtures pin the same version", () => {
  for (const name of ["webhook-vectors.json", "markup-vectors.json", "deeplink-vectors.json"]) {
    it(`${name} contract_version === ${CONTRACT_VERSION}`, () => {
      const p = contractPath(name);
      if (!existsSync(p)) return;
      const fixture = JSON.parse(readFileSync(p, "utf8")) as { contract_version: string };
      expect(fixture.contract_version).toBe(CONTRACT_VERSION);
    });
  }
});

describe("operation coverage", () => {
  it("MyStarsClient implements every expected operation", () => {
    const proto = MyStarsClient.prototype as unknown as Record<string, unknown>;
    for (const op of EXPECTED_OPERATIONS) {
      expect(typeof proto[op], `MyStarsClient.${op}`).toBe("function");
    }
  });
});
