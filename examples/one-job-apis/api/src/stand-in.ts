// A PAYMENT-SIGNATURE that passes the middleware's shape check.
//
// The fields are the ones a Canton payment must carry. The bytes are not a
// prepared transaction and the signature was not made by a key. Verify is
// answered by the in-process facilitator, which is why this is enough for the
// demo and not enough for a ledger.
//
// SPDX-License-Identifier: Apache-2.0

import {
  ASSET_TRANSFER_METHOD,
  encodePaymentHeader,
  type CantonPaymentPayload,
  type CantonPaymentRequirements,
} from "@chainsafe/x402-core";

export const STAND_IN_NOTE =
  "This signature is a stand-in. It has the shape paymentRequired checks. It is not a prepared Canton transaction, and no ledger moved.";

export function signStandIn(accepts: readonly CantonPaymentRequirements[]): string {
  const accepted = accepts[0];
  if (!accepted) throw new Error("the 402 offered no way to pay");
  const payment: CantonPaymentPayload = {
    x402Version: 2,
    accepted,
    payload: {
      assetTransferMethod: ASSET_TRANSFER_METHOD,
      preparedTransaction: "stand-in",
      preparedTxHash: "00".repeat(32),
      signature: "stand-in",
    },
  };
  return encodePaymentHeader(payment);
}
