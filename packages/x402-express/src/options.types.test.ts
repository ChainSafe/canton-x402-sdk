// Type-level tests for the config surface.
//
// The rest of the suite proves these types ACCEPT what they should: every test
// writes valid config, so it passes. Nothing there proves they REJECT what they
// should, which means loosening a constraint is invisible — making `amount`
// optional, or `payer` maybe-undefined, leaves all of it green.
//
// `@ts-expect-error` inverts that: it fails the build when the error it marks
// stops happening. So each one below is a constraint that cannot quietly go
// away. There is nothing to run — `pnpm typecheck` is the assertion, and vitest
// only reports that the file was reached.
//
// SPDX-License-Identifier: Apache-2.0

import { it, expect } from "vitest";
import type { CantonPaymentRequirements } from "@chainsafe/x402-core";

import type {
  AcceptSpec,
  PaymentRequiredOptions,
  RequirementsBuilder,
  RequirementsSpec,
  X402RequestState,
} from "./options.js";
import type { CantonRequirementsSpec } from "./schemes/canton-exact.js";

type Accept = AcceptSpec<CantonRequirementsSpec>;

/* ── a way to pay must carry a price ─────────────────────────────────────── */

const priced: Accept = { amount: "500000000", asset: "Amulet" };

// @ts-expect-error — a way to pay with no price is not a way to pay
const unpriced: Accept = { asset: "USDCx" };

/* ── and must say what it is priced IN ───────────────────────────────────── */

// @ts-expect-error — a price with no asset is 0.05 of whatever turns up
const unnamedInstrument: Accept = { amount: "500000000" };

// The same field pins it whole, admin included.
const pinned: Accept = { amount: "1", asset: { instrumentId: { id: "Amulet", admin: "DSO::x" } } };

// @ts-expect-error — a symbol is not an instrument id, and a half-pinned
// instrument is not one either: the two forms are a string or a whole AssetSpec.
const halfPinned: Accept = { amount: "1", asset: { id: "Amulet" } };

/* ── shared terms are overridable per entry, never required there ────────── */

const overrides: Accept = {
  amount: "1",
  asset: "Amulet",
  payTo: "merchant::other",
  network: "canton:devnet",
  maxTimeoutSeconds: 120,
  resource: "https://elsewhere.example",
};

/* ── the scheme's own fields survive the Omit ────────────────────────────── */

const cantonFields: Accept = {
  amount: "1",
  asset: "Amulet",
  executeBeforeSeconds: 300,
  memo: () => "ref",
};

// @ts-expect-error — a field no scheme defines is still refused
const unknownField: Accept = { amount: "1", asset: "Amulet", nonsense: true };

/* ── the terms name a payee and at least the shape of a list ─────────────── */

const terms: RequirementsSpec = {
  payTo: "merchant::x",
  accepts: [{ amount: "1", asset: "Amulet" }],
};

// @ts-expect-error — `accepts` is the whole point; terms without it are not terms
const noAccepts: RequirementsSpec = { payTo: "merchant::x" };

// @ts-expect-error — someone writing the pre-`accepts` shape should be told
const flatShape: RequirementsSpec = { payTo: "merchant::x", amount: "500000000" };

/* ── a builder returns the whole list, not one requirement ───────────────── */

const listBuilder: RequirementsBuilder = () => [] as CantonPaymentRequirements[];

// @ts-expect-error — returning a single requirement is the old contract
const singleBuilder: RequirementsBuilder = () => ({}) as CantonPaymentRequirements;

/* ── a paid request always names its payer ───────────────────────────────── */

// Expressed as a conditional type rather than by reading a declared value: a
// `declare const` has no runtime binding, and this file is loaded by vitest.
type PayerIsAlwaysPresent = undefined extends X402RequestState["payer"] ? never : true;
const payerIsCertain: PayerIsAlwaysPresent = true;

/* ── the options require a facilitator and terms ─────────────────────────── */

// @ts-expect-error — nothing to verify against
const noFacilitator: PaymentRequiredOptions = { requirements: terms };

it("is a typecheck assertion; `pnpm typecheck` is what enforces it", () => {
  // Referenced so the bindings are not unused. The test asserting `true` is the
  // point: if this file compiles, every constraint above still holds.
  expect([
    priced,
    unpriced,
    unnamedInstrument,
    pinned,
    halfPinned,
    overrides,
    cantonFields,
    unknownField,
    terms,
    noAccepts,
    flatShape,
    listBuilder,
    singleBuilder,
    payerIsCertain,
    noFacilitator,
  ]).toHaveLength(15);
});
