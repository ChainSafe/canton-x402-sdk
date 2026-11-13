import { describe, expect, it } from "vitest";
import { HashingSchemeVersion } from "../types/payment";
import { computePreparedTransactionHash } from "./prepared-tx-hash";
import { decodePreparedTransaction } from "./prepared-tx";
import { encodePreparedTransaction, stringField, wrap } from "./prepared-tx.fixtures";
import type { DecodedTransfer } from "./prepared-tx";

// Prepared transaction and hash returned by a real Canton Ledger API prepare
// call. This vector is also used by @canton-network/core-tx-visualizer v1.7.0.
const LEDGER_PREPARED_TRANSACTION =
  "CsoHCgMyLjESATAamwcKATDCPpQHCpEHCgMyLjESQjAwMTY4Nzc3ODEwNzU3MmJlZWVjYzQzODk3MmQxODQ4M2VhZDI1MGQxZDUwYmI2MzU3ZjdmYjhmNjdkY2U3ZDYzNRoNc3BsaWNlLXdhbGxldCKCAQpAZWI2ZTAxZWZhY2MzMzk3ZTIzYzZiZThiOWJlN2RiNGJmMzc2NzIyMTE5NzRkNjllMjRiNDg5ODBlMmY5OGI3ZRIhU3BsaWNlLldhbGxldC5UcmFuc2ZlclByZWFwcHJvdmFsGhtUcmFuc2ZlclByZWFwcHJvdmFsUHJvcG9zYWwqtQNysgMKggEKQGViNmUwMWVmYWNjMzM5N2UyM2M2YmU4YjliZTdkYjRiZjM3NjcyMjExOTc0ZDY5ZTI0YjQ4OTgwZTJmOThiN2USIVNwbGljZS5XYWxsZXQuVHJhbnNmZXJQcmVhcHByb3ZhbBobVHJhbnNmZXJQcmVhcHByb3ZhbFByb3Bvc2FsElcKCHJlY2VpdmVyEks6SWJvYjo6MTIyMDViZTNiOWQxNzc1NzNmZmZiNjhlYjI0NTk4NmY4OGI5ZGY1OGQ0NGNlNTc1ODE5MDc4OTcwNTgwZDg3ZDFkYzAScgoIcHJvdmlkZXISZjpkYXBwX3VzZXJfbG9jYWxuZXQtbG9jYWxwYXJ0eS0xOjoxMjIwM2E1MmZlNWFmM2I4N2UwNjk2MTgyYWM2NjhhNmNiMzE1ZGFiNGJkYzMwZGE5ZTViNmRkYTllYjcyODc4NDIxNhJeCgtleHBlY3RlZERzbxJPUk0KSzpJRFNPOjoxMjIwYmJkMDAwYjY5ODc1NzNiOGMwOWY0NDRlNGRmNTUwOWFmODk5N2I4MzkxMDlkN2UyYzIxMmQ1NDdmMGFmMDk1MDJJYm9iOjoxMjIwNWJlM2I5ZDE3NzU3M2ZmZmI2OGViMjQ1OTg2Zjg4YjlkZjU4ZDQ0Y2U1NzU4MTkwNzg5NzA1ODBkODdkMWRjMDpkYXBwX3VzZXJfbG9jYWxuZXQtbG9jYWxwYXJ0eS0xOjoxMjIwM2E1MmZlNWFmM2I4N2UwNjk2MTgyYWM2NjhhNmNiMzE1ZGFiNGJkYzMwZGE5ZTViNmRkYTllYjcyODc4NDIxNjpJYm9iOjoxMjIwNWJlM2I5ZDE3NzU3M2ZmZmI2OGViMjQ1OTg2Zjg4YjlkZjU4ZDQ0Y2U1NzU4MTkwNzg5NzA1ODBkODdkMWRjMCIiEiDBzeNcgqLvsssBxhNx7wP9pK71TsAprgz+a8jag/Lb3RL3ARJxCklib2I6OjEyMjA1YmUzYjlkMTc3NTczZmZmYjY4ZWIyNDU5ODZmODhiOWRmNThkNDRjZTU3NTgxOTA3ODk3MDU4MGQ4N2QxZGMwEiQ5NzU4ZTQ2ZS05ZmJlLTRmOTQtOTczZC04NWQ5ZTBmMTMyNzUaU2dsb2JhbC1kb21haW46OjEyMjBiYmQwMDBiNjk4NzU3M2I4YzA5ZjQ0NGU0ZGY1NTA5YWY4OTk3YjgzOTEwOWQ3ZTJjMjEyZDU0N2YwYWYwOTUwKiQ5NGJkYmFmNS0wYjJjLTQwYmMtOTZjZC1jM2M5YTlkODQ3ZDIw+eaGkdz0jwM=";
const LEDGER_PREPARED_TRANSACTION_HASH =
  "7fdec2bf504eed04bb8e6498d37a79e891ac3dfeb4571fc0057991b9bee28902";

describe("computePreparedTransactionHash", () => {
  it("matches the hash returned by a real Canton prepare call", async () => {
    await expect(
      computePreparedTransactionHash(LEDGER_PREPARED_TRANSACTION, HashingSchemeVersion.V2),
    ).resolves.toBe(LEDGER_PREPARED_TRANSACTION_HASH);
  });

  it("treats an absent hashing scheme version as V2", async () => {
    await expect(
      computePreparedTransactionHash(LEDGER_PREPARED_TRANSACTION, undefined),
    ).resolves.toBe(LEDGER_PREPARED_TRANSACTION_HASH);
  });

  it("fails closed for an unsupported hashing scheme", async () => {
    await expect(
      computePreparedTransactionHash(LEDGER_PREPARED_TRANSACTION, HashingSchemeVersion.V3),
    ).rejects.toThrow("unsupported Canton hashing scheme");
  });
});

// The decoder reads the transaction off the SAME parse the signing hash is
// taken over — `hashPreparedTransaction` decodes, re-serialises and re-parses,
// and hashes that. Three rules of the scheme are checked against what the
// decode shows (input contracts, templates, declared holdings), and they mean
// nothing unless the signature covers it.
//
// That property is the vendor's to keep, not ours: it held on 1.16.0 and did
// NOT hold on 1.7.0, where an unreachable node was visible to the decode and
// absent from the hash preimage. So it is pinned here rather than assumed, and
// a vendor release that split the two paths would fail this file rather than
// quietly weaken three security rules.
describe("the hash covers what the decoder reads", () => {
  const TRANSFER: DecodedTransfer = {
    synchronizerId: "global-domain::1220be58c29e",
    sender: "alice::1220beef",
    receiver: "merchant::1220dead",
    amount: "0.01",
    instrumentId: { id: "Amulet", admin: "DSO::1220dso" },
  };

  it("moves the hash when a field the decoder reports changes", async () => {
    const a = encodePreparedTransaction(TRANSFER);
    const b = encodePreparedTransaction({ ...TRANSFER, receiver: "someone-else::1220dead" });
    expect(decodePreparedTransaction(a)?.receiver).not.toBe(decodePreparedTransaction(b)?.receiver);
    expect(await computePreparedTransactionHash(a)).not.toBe(await computePreparedTransactionHash(b));
  });

  it("refuses at the hash whatever the decoder refuses, for an unknown field", async () => {
    // An unknown field is the case that matters: the hash cannot cover a field
    // it does not know, so a decoder that read past one would be reading bytes
    // nobody signed. Both sides must refuse the same input.
    const unknown = encodePreparedTransaction(TRANSFER, {
      extra: { prepared: wrap(15, stringField(1, "unsigned")) },
    });
    expect(decodePreparedTransaction(unknown)).toBeNull();
    await expect(computePreparedTransactionHash(unknown)).rejects.toThrow();
  });
});
