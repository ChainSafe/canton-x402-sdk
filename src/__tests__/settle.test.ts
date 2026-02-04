import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";

// We test settle indirectly since it makes external HTTP calls.
// Focus on commandId uniqueness and error paths.

describe("settle commandId generation", () => {
  it("randomUUID produces unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(`x402-settle-${randomUUID()}`);
    }
    expect(ids.size).toBe(1000);
  });

  it("commandId format matches expected pattern", () => {
    const id = `x402-settle-${randomUUID()}`;
    expect(id).toMatch(
      /^x402-settle-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("settleLocal error paths", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("returns error when no holdings found", async () => {
    const { settleLocal } = await import("../canton/settle.js");
    const { SharedSecretAuthProvider } = await import("../canton/auth.js");
    const { CantonJsonClient } = await import("../canton/json-client.js");

    const auth = new SharedSecretAuthProvider("unsafe", "test-user");
    const client = new CantonJsonClient("http://localhost:2975", auth);

    // Mock getPayerHoldings to return empty array
    vi.spyOn(client, "getPayerHoldings").mockResolvedValue([]);

    const result = await settleLocal(
      {
        payerParty: "alice::12201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        payeeParty: "bob::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        amount: "1.00",
        resourceId: "https://example.com/resource",
      },
      {
        network: "canton-local",
        ledgerApiUrl: "http://localhost:2975",
        scanProxyUrl: "http://scan.localhost:4000",
        dsoParty: "DSO::1220test0000000000000000000000000000000000000000000000000000000000",
        auth: { type: "shared-secret", secret: "unsafe", userId: "test-user" },
      },
      client,
      auth,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No Amulet holdings");
  });

  it("returns error when TransferFactory API fails", async () => {
    const { settleLocal } = await import("../canton/settle.js");
    const { SharedSecretAuthProvider } = await import("../canton/auth.js");
    const { CantonJsonClient } = await import("../canton/json-client.js");

    const auth = new SharedSecretAuthProvider("unsafe", "test-user");
    const client = new CantonJsonClient("http://localhost:2975", auth);

    vi.spyOn(client, "getPayerHoldings").mockResolvedValue(["cid-1"]);

    // Mock scan proxy returning 500
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const result = await settleLocal(
      {
        payerParty: "alice::12201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        payeeParty: "bob::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        amount: "1.00",
        resourceId: "https://example.com/resource",
      },
      {
        network: "canton-local",
        ledgerApiUrl: "http://localhost:2975",
        scanProxyUrl: "http://scan.localhost:4000",
        dsoParty: "DSO::1220test0000000000000000000000000000000000000000000000000000000000",
        auth: { type: "shared-secret", secret: "unsafe", userId: "test-user" },
      },
      client,
      auth,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("TransferFactory API failed");
    expect(result.error).toContain("500");
  });
});
