// Canton x402 SDK -- Canton JSON API v2 Client

import type { AuthProvider } from "./auth.js";

/**
 * HTTP client for the Canton Ledger JSON API v2.
 */
export class CantonJsonClient {
  constructor(
    private ledgerApiUrl: string,
    private auth: AuthProvider,
  ) {}

  /** GET /livez -- health check */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ledgerApiUrl}/livez`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** POST /v2/state/active-contracts */
  async getActiveContracts(
    party: string,
    filter: Record<string, unknown>,
  ): Promise<unknown[]> {
    const token = await this.auth.getToken();
    const userId = this.auth.getUserId();

    // Get ledger end offset first
    const ledgerEndRes = await fetch(
      `${this.ledgerApiUrl}/v2/state/ledger-end`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!ledgerEndRes.ok) {
      throw new Error(`Failed to get ledger end: ${ledgerEndRes.status}`);
    }
    const ledgerEnd = (await ledgerEndRes.json()) as { offset: string };

    const response = await fetch(
      `${this.ledgerApiUrl}/v2/state/active-contracts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          activeAtOffset: ledgerEnd.offset,
          filter,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Active contracts query failed: ${response.status} ${errorText}`);
    }
    return (await response.json()) as unknown[];
  }

  /**
   * Get Amulet holdings for a party.
   * Returns an array of contract IDs.
   */
  async getPayerHoldings(party: string, spliceHoldingPackageId?: string): Promise<string[]> {
    const pkgId =
      spliceHoldingPackageId ??
      "718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b";

    const entries = await this.getActiveContracts(party, {
      filtersByParty: {
        [party]: {
          filters: [
            {
              interfaceFilter: {
                interfaceId: `${pkgId}:Splice.Api.Token.HoldingV1:Holding`,
                includeView: true,
              },
            },
          ],
        },
      },
    });

    const holdingCids: string[] = [];
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      const contract =
        (e.contractEntry as Record<string, unknown>)?.JsActiveContract ??
        (e.contractEntry as Record<string, unknown>)?.activeContract ??
        (e as Record<string, unknown>).JsActiveContract ??
        (e as Record<string, unknown>).activeContract ??
        (e.createdEvent ? e : null);
      if (!contract) continue;

      const c = contract as Record<string, unknown>;
      const createdEvent = c.createdEvent as Record<string, unknown> | undefined;
      const cid = (createdEvent?.contractId ?? c.contractId) as string | undefined;
      if (!cid || typeof cid !== "string" || !cid.startsWith("00")) continue;

      const templateId = (
        (createdEvent?.templateId ?? c.templateId) as string | undefined
      ) ?? "";
      if (
        !templateId.includes("Splice.Amulet:Amulet") ||
        templateId.includes("AcceptedTransferOffer") ||
        templateId.includes("TransferOffer")
      ) {
        continue;
      }
      holdingCids.push(cid);
    }
    return holdingCids;
  }

  /** POST /v2/commands/submit-and-wait -- direct command submission (localnet) */
  async submitAndWait(command: Record<string, unknown>): Promise<{
    updateId: string;
    completionOffset: string;
  }> {
    const token = await this.auth.getToken();
    const response = await fetch(
      `${this.ledgerApiUrl}/v2/commands/submit-and-wait`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      },
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Submit-and-wait failed: ${response.status} ${errorText}`);
    }
    return (await response.json()) as {
      updateId: string;
      completionOffset: string;
    };
  }

  /** POST /v2/updates/transaction-by-id */
  async getTransactionById(
    updateId: string,
    parties: string[],
  ): Promise<unknown> {
    const token = await this.auth.getToken();
    const filtersByParty: Record<string, { cumulative: unknown[] }> = {};
    for (const p of parties) {
      filtersByParty[p] = { cumulative: [] };
    }

    const response = await fetch(
      `${this.ledgerApiUrl}/v2/updates/transaction-by-id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          updateId,
          transactionFormat: {
            eventFormat: { filtersByParty, verbose: true },
            transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
          },
        }),
      },
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Transaction query failed: ${response.status} - ${errorText}`,
      );
    }
    return response.json();
  }

  /** GET /v2/parties -- discover known parties */
  async getParties(): Promise<unknown[]> {
    const token = await this.auth.getToken();
    const response = await fetch(`${this.ledgerApiUrl}/v2/parties`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Parties query failed: ${response.status} ${errorText}`);
    }
    return (await response.json()) as unknown[];
  }
}
