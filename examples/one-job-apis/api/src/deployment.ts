// Parties and the /v2/supported answer the merchant quotes from.
//
// Nothing here is a Canton deployment. The names are stable so a 402 is the
// same shape every time, and the panel can point at them.
//
// SPDX-License-Identifier: Apache-2.0

import { LOCALNET_NETWORK, type SupportedResponse } from "@chainsafe/x402-core";

export const NETWORK = LOCALNET_NETWORK;
export const MERCHANT = "one-job::1220demo";
export const FEE_PAYER = "one-job-facilitator::1220fee";
export const SYNCHRONIZER = "one-job-sync::1220sync";
export const DSO = "one-job-dso::1220dso";
/** The party verify reports. The stand-in signature does not prove it. */
export const STAND_IN_PAYER = "demo-payer::1220stand-in";
export const DEMO_TRANSACTION = "one-job-demo-update";

export const SUPPORTED: SupportedResponse = {
  kinds: [
    {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      extra: {
        transferMethods: ["transfer-factory"],
        synchronizerId: SYNCHRONIZER,
        feePayer: FEE_PAYER,
        carriages: ["inline"],
        instruments: [
          { admin: DSO, instrumentId: { id: "Amulet", admin: DSO }, symbol: "CC" },
        ],
      },
    },
  ],
  extensions: [],
  signers: { "canton:*": [FEE_PAYER] },
};
