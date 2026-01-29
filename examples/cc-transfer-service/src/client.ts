/**
 * CC Transfer Service Client
 *
 * Sends 0.50 CC and then queries the transaction.
 */

import { loadEnv } from "../../shared/env.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { payerParty, payeeParty } = loadEnv(join(__dirname, "..", ".env"));

const SERVER = "http://localhost:4020";

async function main() {
  console.log("Canton x402 SDK -- CC Transfer Service Client\n");

  // 1. Execute transfer
  console.log(`Transferring 0.50 CC from app-user to app-provider...`);
  const transferRes = await fetch(`${SERVER}/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: payerParty,
      to: payeeParty,
      amount: "0.50",
    }),
  });

  const result = (await transferRes.json()) as {
    success: boolean;
    transactionId?: string;
    error?: string;
  };

  if (!result.success) {
    console.error(`Transfer failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`Transfer successful!`);
  console.log(`  Transaction ID: ${result.transactionId}`);

  // 2. Query the transaction
  if (result.transactionId) {
    console.log(`\nQuerying transaction...`);
    const txRes = await fetch(
      `${SERVER}/transfers/${encodeURIComponent(result.transactionId)}`,
    );
    const txData = await txRes.json();
    console.log(`Transaction details:`);
    console.log(JSON.stringify(txData, null, 2));
  }
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});
