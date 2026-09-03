import { hashPreparedTransaction } from "@canton-network/core-tx-visualizer";
import {
  HashingSchemeVersion,
  type HashingSchemeVersion as CantonHashingSchemeVersion,
} from "../types/payment";

/**
 * Derive the canonical Canton signing hash from a prepared transaction.
 *
 * core-tx-visualizer currently implements Canton hashing scheme V2.
 * Unsupported versions must fail closed.
 */
export async function computePreparedTransactionHash(
  preparedTransaction: string,
  hashingSchemeVersion: CantonHashingSchemeVersion,
): Promise<string> {
  if (hashingSchemeVersion !== HashingSchemeVersion.V2) {
    throw new Error(`unsupported Canton hashing scheme: ${hashingSchemeVersion}`);
  }

  return hashPreparedTransaction(preparedTransaction, "hex");
}
