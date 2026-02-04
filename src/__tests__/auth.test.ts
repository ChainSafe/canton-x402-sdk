import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SharedSecretAuthProvider,
  OAuth2AuthProvider,
  createAuthProvider,
} from "../canton/auth.js";
import type { CantonSdkConfig } from "../types.js";

describe("SharedSecretAuthProvider", () => {
  it("generates a valid HS256 JWT", async () => {
    const provider = new SharedSecretAuthProvider("test-secret", "alice");
    const token = await provider.getToken();

    // JWT has 3 parts
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    // Decode header
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header.alg).toBe("HS256");

    // Decode payload
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.sub).toBe("alice");
    expect(payload.aud).toBe("https://canton.network.global");
    expect(payload.scope).toBe("daml_ledger_api");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("caches token on subsequent calls", async () => {
    const provider = new SharedSecretAuthProvider("test-secret", "bob");
    const token1 = await provider.getToken();
    const token2 = await provider.getToken();
    expect(token1).toBe(token2);
  });

  it("returns configured userId", () => {
    const provider = new SharedSecretAuthProvider("secret", "my-user");
    expect(provider.getUserId()).toBe("my-user");
  });

  it("uses custom audience when provided", async () => {
    const provider = new SharedSecretAuthProvider(
      "secret",
      "user",
      "custom-audience",
    );
    const token = await provider.getToken();
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.aud).toBe("custom-audience");
  });
});

describe("OAuth2AuthProvider", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("fetches token via client_credentials grant", async () => {
    const fakeToken =
      "eyJhbGciOiJSUzI1NiJ9." +
      Buffer.from(JSON.stringify({ sub: "oauth-user", exp: 9999999999 })).toString("base64url") +
      ".signature";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: fakeToken,
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });

    const provider = new OAuth2AuthProvider({
      tokenUrl: "https://auth.example.com/token",
      clientId: "test-id",
      clientSecret: "test-secret",
    });

    const token = await provider.getToken();
    expect(token).toBe(fakeToken);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://auth.example.com/token");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("throws on failed token request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid client credentials"),
    });

    const provider = new OAuth2AuthProvider({
      tokenUrl: "https://auth.example.com/token",
      clientId: "bad-id",
      clientSecret: "bad-secret",
    });

    await expect(provider.getToken()).rejects.toThrow(
      /OAuth2 token request failed/,
    );
  });

  it("caches token within expiry window", async () => {
    const fakeToken =
      "eyJhbGciOiJSUzI1NiJ9." +
      Buffer.from(JSON.stringify({ sub: "user", exp: 9999999999 })).toString("base64url") +
      ".sig";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: fakeToken,
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });

    const provider = new OAuth2AuthProvider({
      tokenUrl: "https://auth.example.com/token",
      clientId: "id",
      clientSecret: "secret",
    });

    await provider.getToken();
    await provider.getToken();
    // Only one fetch call due to caching
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws if getUserId called before getToken", () => {
    const provider = new OAuth2AuthProvider({
      tokenUrl: "https://auth.example.com/token",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(() => provider.getUserId()).toThrow(/Must call getToken/);
  });

  it("extracts userId from JWT sub claim", async () => {
    const fakeToken =
      "eyJhbGciOiJSUzI1NiJ9." +
      Buffer.from(JSON.stringify({ sub: "extracted-user-id", exp: 9999999999 })).toString("base64url") +
      ".sig";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: fakeToken,
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });

    const provider = new OAuth2AuthProvider({
      tokenUrl: "https://auth.example.com/token",
      clientId: "id",
      clientSecret: "secret",
    });

    await provider.getToken();
    expect(provider.getUserId()).toBe("extracted-user-id");
  });
});

describe("createAuthProvider", () => {
  it("creates SharedSecretAuthProvider for shared-secret type", () => {
    const provider = createAuthProvider({
      type: "shared-secret",
      secret: "test",
      userId: "user",
    });
    expect(provider.getUserId()).toBe("user");
  });

  it("creates OAuth2AuthProvider for oauth2 type", () => {
    const provider = createAuthProvider({
      type: "oauth2",
      tokenUrl: "https://auth.example.com/token",
      clientId: "id",
      clientSecret: "secret",
    });
    // OAuth2 throws if getToken not called first
    expect(() => provider.getUserId()).toThrow();
  });

  it("validates config when full config provided", () => {
    expect(() =>
      createAuthProvider(
        { type: "shared-secret", secret: "unsafe", userId: "user" },
        {
          network: "canton-devnet",
          ledgerApiUrl: "https://ledger.example.com",
          scanProxyUrl: "https://scan.example.com",
          dsoParty: "DSO::1220abcdef",
          auth: { type: "shared-secret", secret: "unsafe", userId: "user" },
        },
      ),
    ).toThrow(/not allowed/);
  });

  it("skips validation when config not provided", () => {
    expect(() =>
      createAuthProvider({
        type: "shared-secret",
        secret: "unsafe",
        userId: "user",
      }),
    ).not.toThrow();
  });
});
