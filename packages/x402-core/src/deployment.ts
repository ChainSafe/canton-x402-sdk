// Reading a facilitator's /v2/supported as configuration.
//
// The shapes live in types/facilitator.ts, with the rest of the endpoint's
// contract. What is here is the decision: given what a deployment advertises and
// what a merchant left unspecified, which terms should it quote? That is policy
// — ambiguity is refused rather than guessed at, and an inconsistent response is
// refused rather than half-believed — so it sits beside the other behaviour
// modules rather than among the types.
//
// The point of configuring from here at all: the facilitator advertises what it
// settles — the synchronizer it submits to, the instruments it validates, the
// transfer method it speaks — so a merchant that configures from it is
// configuring from the thing that will accept or refuse its payments, rather
// than from a constant someone copied into a deployment and has to keep true.
//
// SPDX-License-Identifier: Apache-2.0

import { cantonSupportedExtra } from "./types/facilitator";
import type {
  CantonSupportedExtra,
  SupportedKind,
  SupportedResponse,
} from "./types/facilitator";
import type { InstrumentId } from "./types/common";
import { assetSymbol } from "./networks";

/**
 * What a deployment advertises, in the protocol's own terms.
 *
 * `scheme`, `network` and `asset` are every scheme's: the x402 spec types
 * `asset` as a string whatever the scheme, so whatever a string cannot carry
 * belongs in `extra` — the same seam the wire types use.
 */
export interface DeploymentTerms<TExtra = unknown> {
  scheme: string;
  network: string;
  /** Display symbol for the requirements' `asset`. */
  asset: string;
  /** The scheme's own part, read out of `kinds[].extra`. */
  extra: TExtra;
}

/**
 * Turns one advertised kind into the scheme's part of the terms — possibly
 * several, when the kind settles several things.
 *
 * This is the seam. Picking WHICH kinds match is the protocol's business and is
 * done once, in {@link selectKinds}; reading `kinds[].extra` is the scheme's,
 * because `extra` is Optional and scheme-defined in x402 v2 §7.3 and no two
 * schemes spell it the same way. A selector may refuse, with
 * {@link DeploymentSelectionError}, when the kind it is handed advertises
 * nothing it can use.
 */
export type DeploymentExtraSelector<TExtra> = (
  kind: SupportedKind,
) => Array<{ asset: string; extra: TExtra }>;

/**
 * Narrow which kinds to quote. Lists, because a 402 advertises a LIST of ways
 * to pay — a merchant accepting two networks is making a choice, not failing to
 * make one. Omit a field to accept any.
 */
export interface DeploymentPreference {
  schemes?: string[];
  networks?: string[];
}

/** canton-exact adds the instrument to the choice. */
export interface CantonDeploymentPreference extends DeploymentPreference {
  /** Instrument `id`s, e.g. `["Amulet"]`. */
  instruments?: string[];
}

/** The canton-exact part of what a deployment advertises. */
export interface CantonDeploymentExtra {
  instrumentId: InstrumentId;
  /** The synchronizer to prepare against. Required of a canton-exact extra. */
  synchronizerId: string;
  /**
   * The facilitator's own party, to quote as `extra.feePayer`. Absent when the
   * facilitator does not advertise one.
   */
  feePayer?: string;
}

/** What a merchant needs in order to quote a canton-exact payment. */
export type CantonDeploymentTerms = DeploymentTerms<CantonDeploymentExtra>;

/**
 * Thrown when `/v2/supported` cannot answer what a merchant asked for —
 * deliberately NOT prefixed: it carries nothing scheme-specific, and both the
 * kind selection here and a scheme's own selector raise it.
 *
 * The message names what is on offer, since the fix is to pick from it.
 */
export class DeploymentSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentSelectionError";
  }
}

/**
 * Every kind matching the preference, in the order the facilitator advertised
 * them. Throws only when NOTHING matches.
 *
 * Not exported: nothing outside this file wants the protocol's half on its own,
 * and `supported.kinds` is right there for anyone who does. One line from being
 * public the day something needs it.
 */
function selectKinds(
  supported: SupportedResponse,
  prefer: DeploymentPreference = {},
): SupportedKind[] {
  const matching = supported.kinds.filter(
    (k) =>
      (prefer.networks === undefined || prefer.networks.includes(k.network)) &&
      (prefer.schemes === undefined || prefer.schemes.includes(k.scheme)),
  );
  if (matching.length === 0) {
    throw new DeploymentSelectionError(
      `facilitator advertises no kind matching ${describe(prefer)}; it settles ${
        supported.kinds.map(label).join(", ") || "nothing"
      }`,
    );
  }
  return matching;
}

/**
 * Every set of terms this facilitator offers for the preferred kinds — one per
 * way to pay, which is what a 402's `accepts[]` carries.
 *
 * Each entry still needs its own price: a merchant advertising two instruments
 * is quoting two amounts, and 0.05 of one token is not 0.05 of another. That
 * pairing is the merchant's, which is why this returns terms and not quotes.
 *
 * Nor is there an "exactly one" wrapper, scheme-specific or otherwise. Core
 * reports what is on offer; whether offering several is an error is the
 * merchant layer's call, and only that layer can say how to fix it — it knows
 * the quote is configured as `network:`/`instrument:` on a requirements spec,
 * which is not what this function's parameters are called.
 */
export function selectDeployments<TExtra>(
  supported: SupportedResponse,
  selectExtra: DeploymentExtraSelector<TExtra>,
  prefer: DeploymentPreference = {},
): Array<DeploymentTerms<TExtra>> {
  return selectKinds(supported, prefer).flatMap((kind) =>
    selectExtra(kind).map(({ asset, extra }) => ({
      scheme: kind.scheme,
      network: kind.network,
      asset,
      extra,
    })),
  );
}

/**
 * Read a kind's `extra` as canton-exact: the instruments it settles, each with
 * its symbol, the synchronizer to submit to, and the facilitator's own party
 * when it advertises one.
 *
 * Not exported for the same reason: a second scheme writes its own selector
 * against {@link DeploymentExtraSelector} rather than reaching for this one.
 */
function cantonExtraSelector(
  instruments?: string[],
): DeploymentExtraSelector<CantonDeploymentExtra> {
  return (kind) => {
    const advertised = cantonSupportedExtra(kind);
    return selectInstruments(kind, advertised, instruments).map((instrumentId) => {
      const extra: CantonDeploymentExtra = {
        instrumentId,
        synchronizerId: advertised.synchronizerId,
        // Only when advertised, so an absent one stays absent rather than
        // turning into a `feePayer: undefined` key.
        ...(advertised.feePayer === undefined ? {} : { feePayer: advertised.feePayer }),
      };
      return {
        // The advertised symbol when there is one, since the deployment knows
        // its own token's name; assetSymbol only knows the ones compiled here.
        asset: advertisedSymbol(advertised, instrumentId) ?? assetSymbol(instrumentId),
        extra,
      };
    });
  };
}

/**
 * Every canton-exact way to pay this facilitator offers.
 *
 * The selector runs on every kind that matched, so pass `schemes`/`networks`
 * when a facilitator also settles something this reader cannot read — otherwise
 * a kind with no `extra.instruments` is refused on its own terms rather than
 * skipped. Our own facilitator settles canton only, and the Express adapter
 * always names a scheme.
 */
export function selectCantonDeployments(
  supported: SupportedResponse,
  prefer: CantonDeploymentPreference = {},
): CantonDeploymentTerms[] {
  return selectDeployments(supported, cantonExtraSelector(prefer.instruments), prefer);
}

/** `scheme/network`, as the error messages name a kind. */
function label(kind: { scheme: string; network: string }): string {
  return `${kind.scheme}/${kind.network}`;
}

function selectInstruments(
  kind: SupportedKind,
  extra: CantonSupportedExtra,
  want: string[] | undefined,
): InstrumentId[] {
  // `admin` alone cannot name an instrument, so an entry without an
  // instrumentId is not a way to pay.
  //
  // Only what is listed. A deployment that leaves Canton Coin implied by the
  // scheme — the registered one does, listing CIP-56 tokens only — is read as
  // not settling it, and discovery will not produce it. That is deliberate:
  // synthesising an entry nobody advertised would mean quoting against a
  // deployment on the strength of a convention rather than its own answer.
  // A merchant paying Canton Coin there pins `network` and `asset`, which
  // skips discovery altogether.
  const listed = (extra.instruments ?? []).filter((i) => i.instrumentId !== undefined);
  const matching =
    want === undefined ? listed : listed.filter((i) => want.includes(i.instrumentId?.id ?? ""));

  if (matching.length === 0) {
    // What the facilitator said, and nothing about what to do next: core does
    // not know how the caller's quote is configured, which is the same reason
    // there is no singular form of this function.
    const offered = listed.map((i) => i.instrumentId?.id).filter(Boolean);
    throw new DeploymentSelectionError(
      `facilitator kind ${label(kind)} advertises no instrument${
        want === undefined
          ? ""
          : want.length === 0
            ? " with an empty id list"
            : ` with id ${want.map((w) => `"${w}"`).join(" or ")}`
      } in extra.instruments${offered.length > 0 ? `; it lists ${offered.join(", ")}` : ""}`,
    );
  }

  return matching.map((entry) => {
    // `instrumentId` was the filter, so it is present.
    const instrumentId = entry.instrumentId as InstrumentId;
    // The two spellings of the admin party must agree. Disagreeing means the
    // response is inconsistent about who validates the holding, and quoting
    // either would be a guess at which half is right.
    if (entry.admin !== undefined && entry.admin !== instrumentId.admin) {
      throw new DeploymentSelectionError(
        `facilitator advertises instrument "${instrumentId.id}" with admin "${entry.admin}" but instrumentId.admin "${instrumentId.admin}"`,
      );
    }
    return instrumentId;
  });
}

function advertisedSymbol(
  extra: CantonSupportedExtra,
  instrument: InstrumentId,
): string | undefined {
  const match = (extra.instruments ?? []).find(
    (i) => i.instrumentId?.id === instrument.id && i.instrumentId.admin === instrument.admin,
  );
  return match?.symbol;
}

function describe(prefer: DeploymentPreference): string {
  const parts = [list("scheme", prefer.schemes), list("network", prefer.networks)].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(" + ") : "any scheme/network";
}

function list(what: string, values: string[] | undefined): string | undefined {
  if (values === undefined) return undefined;
  // An empty list matches nothing, and is almost always a caller's list that
  // came out empty. Saying so beats reading it as "any", which would silently
  // match everything and turn that mistake into a wrong-but-working quote.
  if (values.length === 0) return `an empty ${what} list`;
  return `${what}${values.length === 1 ? "" : "s"} ${values.map((v) => `"${v}"`).join(" or ")}`;
}
