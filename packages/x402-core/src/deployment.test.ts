import { describe, it, expect } from "vitest";

import {
  cantonSupportedExtra,
  selectCantonDeployments,
  selectDeployments,
  DeploymentSelectionError,
  type SupportedResponse,
} from "./index";

const DSO = "DSO::1220be58";
const amulet = { id: "Amulet", admin: DSO };

const kind = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  x402Version: 2,
  scheme: "exact",
  network: "canton:devnet",
  extra: {
    transferMethods: ["transfer-factory"],
    synchronizerId: "global-domain::1220be58",
    carriages: ["inline"],
    instruments: [{ admin: DSO, instrumentId: amulet, symbol: "CC" }],
  },
  ...over,
});

const response = (...kinds: Array<Record<string, unknown>>): SupportedResponse =>
  ({ kinds }) as unknown as SupportedResponse;

describe("selectCantonDeployments", () => {
  it("reads the terms a merchant needs from a single advertised kind", () => {
    expect(selectCantonDeployments(response(kind()))).toEqual([
      {
        scheme: "exact",
        network: "canton:devnet",
        asset: "CC",
        extra: { instrumentId: amulet, synchronizerId: "global-domain::1220be58" },
      },
    ]);
  });

  it("takes the DSO from the response, not from a constant compiled in here", () => {
    // The point of configuring from /supported: a deployment with its own DSO
    // is quoted with that DSO, with nothing to keep in sync.
    const other = { id: "Amulet", admin: "DSO::other" };
    const [terms] = selectCantonDeployments(
      response(kind({ extra: { instruments: [{ instrumentId: other }] } })),
    );
    expect(terms.extra.instrumentId.admin).toBe("DSO::other");
  });

  it("prefers the advertised symbol over the one derived from the instrument id", () => {
    const [terms] = selectCantonDeployments(
      response(kind({ extra: { instruments: [{ instrumentId: amulet, symbol: "CantonCoin" }] } })),
    );
    expect(terms.asset).toBe("CantonCoin");
  });

  it("derives a symbol when the facilitator advertises none", () => {
    const [terms] = selectCantonDeployments(
      response(kind({ extra: { instruments: [{ instrumentId: amulet }] } })),
    );
    expect(terms.asset).toBe("CC");
  });

  it("omits synchronizerId when the deployment advertises none", () => {
    const [terms] = selectCantonDeployments(
      response(kind({ extra: { instruments: [{ instrumentId: amulet }] } })),
    );
    expect("synchronizerId" in terms.extra).toBe(false);
  });

  it("returns a way to pay for each kind, rather than choosing between them", () => {
    // Core reports what is on offer; whether offering two networks is an error
    // is the merchant layer's call.
    const all = selectCantonDeployments(response(kind(), kind({ network: "canton:mainnet" })));
    expect(all.map((t) => t.network)).toEqual(["canton:devnet", "canton:mainnet"]);
  });

  it("resolves that ambiguity when the merchant names the network", () => {
    const [terms] = selectCantonDeployments(response(kind(), kind({ network: "canton:mainnet" })), {
      networks: ["canton:mainnet"],
    });
    expect(terms.network).toBe("canton:mainnet");
  });

  it("names what the facilitator does settle when the merchant asks for something else", () => {
    const err = catchError(() => selectCantonDeployments(response(kind()), { networks: ["canton:nope"] }));
    expect(err.message).toContain("canton:nope");
    expect(err.message).toContain("exact/canton:devnet");
  });

  it("resolves that when the merchant names the instrument", () => {
    const usdc = { id: "USDCx", admin: "ISSUER::x" };
    const [terms] = selectCantonDeployments(
      response(kind({ extra: { instruments: [{ instrumentId: amulet }, { instrumentId: usdc }] } })),
      { instruments: ["USDCx"] },
    );
    expect(terms.extra.instrumentId).toEqual(usdc);
  });

  it("says so when a kind advertises no instruments at all", () => {
    const err = catchError(() => selectCantonDeployments(response(kind({ extra: {} }))));
    expect(err).toBeInstanceOf(DeploymentSelectionError);
    expect(err.message).toContain("extra.instruments");
  });

  it("says so when `extra` is missing entirely", () => {
    const { extra: _drop, ...noExtra } = kind();
    const err = catchError(() => selectCantonDeployments(response(noExtra)));
    expect(err).toBeInstanceOf(DeploymentSelectionError);
  });

  it("refuses an instrument whose two admin spellings disagree", () => {
    // The response is then inconsistent about who validates the holding, and
    // either half could be the wrong one to quote.
    const err = catchError(() =>
      selectCantonDeployments(
        response(kind({ extra: { instruments: [{ admin: "DSO::other", instrumentId: amulet }] } })),
      ),
    );
    expect(err).toBeInstanceOf(DeploymentSelectionError);
    expect(err.message).toContain("DSO::other");
  });

  it("skips an advertised entry that carries no instrumentId", () => {
    // `admin` alone cannot name an instrument, so it is not a choice.
    const err = catchError(() =>
      selectCantonDeployments(response(kind({ extra: { instruments: [{ admin: DSO }] } }))),
    );
    expect(err.message).toContain("advertises no instrument");
  });
});

describe("cantonSupportedExtra (types/facilitator)", () => {
  it("reads the keys this scheme defines", () => {
    expect(cantonSupportedExtra(kind() as never)).toMatchObject({
      transferMethods: ["transfer-factory"],
      carriages: ["inline"],
    });
  });

  it("passes through keys it does not know, since extra is where deployments put their own", () => {
    const extra = cantonSupportedExtra(kind({ extra: { somethingElse: 7 } }) as never);
    expect(extra).toMatchObject({ somethingElse: 7 });
  });

  it("reads a malformed extra as empty rather than throwing", () => {
    expect(cantonSupportedExtra(kind({ extra: { instruments: "not-an-array" } }) as never)).toEqual({});
  });
});

/** Run `fn`, expecting it to throw, and hand back the error. */
function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw, got none");
}

describe("selectDeployments with a selector that is not canton's", () => {
  // The seam only means something if a scheme that shares none of canton's
  // vocabulary can use it. If any canton assumption were left in the generic
  // half, these fail and the canton ones do not.
  const voucherKind = {
    x402Version: 2,
    scheme: "voucher",
    network: "vouchers:test",
    extra: { book: "autumn-2026", denominations: [5, 10] },
  };

  const voucherSelector = (k: Parameters<typeof cantonSupportedExtra>[0]) => {
    const extra = k.extra as { book?: string } | undefined;
    if (typeof extra?.book !== "string") {
      throw new DeploymentSelectionError(`kind ${k.scheme}/${k.network} advertises no voucher book`);
    }
    return [{ asset: "VCH", extra: { book: extra.book } }];
  };

  it("returns the protocol's fields plus whatever the selector read", () => {
    expect(selectDeployments(response(voucherKind), voucherSelector)).toEqual([
      {
        scheme: "voucher",
        network: "vouchers:test",
        asset: "VCH",
        extra: { book: "autumn-2026" },
      },
    ]);
  });

  it("runs the selector once per matching kind and returns every way to pay", () => {
    let called = 0;
    const counting = (k: Parameters<typeof voucherSelector>[0]) => {
      called += 1;
      return voucherSelector(k);
    };
    const all = selectDeployments(
      response(voucherKind, { ...voucherKind, network: "vouchers:live" }),
      counting,
    );
    expect(all.map((t) => t.network)).toEqual(["vouchers:test", "vouchers:live"]);
    expect(called).toBe(2);
  });

  it("refuses a preference nothing matches without consulting the selector at all", () => {
    // Zero matches is the protocol's half of the decision, settled before any
    // scheme code runs.
    let called = 0;
    const counting = (k: Parameters<typeof voucherSelector>[0]) => {
      called += 1;
      return voucherSelector(k);
    };
    const err = catchError(() =>
      selectDeployments(response(voucherKind), counting, { networks: ["vouchers:nope"] }),
    );
    expect(err).toBeInstanceOf(DeploymentSelectionError);
    expect(called).toBe(0);
  });

  it("lets the selector refuse a kind that does not advertise what it needs", () => {
    const err = catchError(() =>
      selectDeployments(response({ ...voucherKind, extra: {} }), voucherSelector),
    );
    expect(err).toBeInstanceOf(DeploymentSelectionError);
    expect(err.message).toContain("no voucher book");
  });

  it("never reads canton's keys for a scheme that has none", () => {
    // A voucher kind carries no instruments; canton's selector would refuse it,
    // which is the point of the selector being the scheme's and not the base's.
    const err = catchError(() => selectCantonDeployments(response(voucherKind)));
    expect(err.message).toContain("extra.instruments");
    expect(selectDeployments(response(voucherKind), voucherSelector)[0].asset).toBe("VCH");
  });
});

describe("preference that matches nothing", () => {
  it("names what the facilitator does settle", () => {
    const err = catchError(() => selectCantonDeployments(response(kind()), { schemes: ["voucher"] }));
    expect(err.message).toContain('scheme "voucher"');
    expect(err.message).toContain("exact/canton:devnet");
  });
});

describe("selectCantonDeployments: every way to pay", () => {
  const usdc = { id: "USDCx", admin: "ISSUER::x" };
  const twoInstruments = kind({
    extra: {
      synchronizerId: "global-domain::1220be58",
      instruments: [{ instrumentId: amulet, symbol: "CC" }, { instrumentId: usdc, symbol: "USDCx" }],
    },
  });

  it("returns one entry per instrument, which is what accepts[] carries", () => {
    // The singular form refuses this as ambiguous; a merchant advertising both
    // is making a choice, not failing to make one.
    const all = selectCantonDeployments(response(twoInstruments));
    expect(all.map((t) => t.asset)).toEqual(["CC", "USDCx"]);
    expect(all.map((t) => t.extra.instrumentId)).toEqual([amulet, usdc]);
  });

  it("returns one entry per instrument per kind", () => {
    const all = selectCantonDeployments(
      response(twoInstruments, { ...twoInstruments, network: "canton:mainnet" }),
    );
    expect(all.map((t) => `${t.network}/${t.asset}`)).toEqual([
      "canton:devnet/CC",
      "canton:devnet/USDCx",
      "canton:mainnet/CC",
      "canton:mainnet/USDCx",
    ]);
  });

  it("keeps the facilitator's advertised order, so a merchant's accepts[] is predictable", () => {
    const reversed = kind({
      extra: { instruments: [{ instrumentId: usdc }, { instrumentId: amulet }] },
    });
    expect(selectCantonDeployments(response(reversed)).map((t) => t.extra.instrumentId.id)).toEqual([
      "USDCx",
      "Amulet",
    ]);
  });

  it("narrows to several, not just to one", () => {
    const three = kind({
      extra: {
        instruments: [
          { instrumentId: amulet },
          { instrumentId: usdc },
          { instrumentId: { id: "EURx", admin: "ISSUER::e" } },
        ],
      },
    });
    const all = selectCantonDeployments(response(three), { instruments: ["Amulet", "EURx"] });
    expect(all.map((t) => t.extra.instrumentId.id)).toEqual(["Amulet", "EURx"]);
  });

  it("still refuses when nothing matches what was asked for", () => {
    const err = catchError(() =>
      selectCantonDeployments(response(twoInstruments), { instruments: ["GBPx"] }),
    );
    expect(err).toBeInstanceOf(DeploymentSelectionError);
    expect(err.message).toContain('"GBPx"');
  });

  it("narrowing to exactly one is the caller's business, not an error here", () => {
    const [terms] = selectCantonDeployments(response(twoInstruments), { instruments: ["USDCx"] });
    expect(terms.extra.instrumentId).toEqual(usdc);
  });
});

describe("selectDeployments with a selector returning several", () => {
  it("flattens a scheme that offers more than one way to pay per kind", () => {
    // The seam is plural at both levels: several kinds, and several ways to pay
    // within a kind.
    const voucherKind = {
      x402Version: 2,
      scheme: "voucher",
      network: "vouchers:test",
      extra: { books: ["autumn-2026", "spring-2027"] },
    };
    const selector = (k: { extra?: unknown }) =>
      ((k.extra as { books?: string[] }).books ?? []).map((book) => ({
        asset: "VCH",
        extra: { book },
      }));
    const all = selectDeployments(response(voucherKind), selector);
    expect(all.map((t) => t.extra.book)).toEqual(["autumn-2026", "spring-2027"]);
    expect(all.every((t) => t.scheme === "voucher" && t.network === "vouchers:test")).toBe(true);
  });
});
