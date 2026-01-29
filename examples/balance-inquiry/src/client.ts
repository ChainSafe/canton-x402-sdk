/**
 * Balance Inquiry Client
 *
 * Queries own CC balance via the balance inquiry API.
 */

import { loadEnv } from "../../shared/env.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { payerParty } = loadEnv(join(__dirname, "..", ".env"));

const SERVER = "http://localhost:4030";

async function main() {
  console.log("Canton x402 SDK -- Balance Inquiry Client\n");

  // Query default payer's balance
  console.log("Querying default payer balance...");
  const res = await fetch(`${SERVER}/balance`);

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log("Balance data received:");
  console.log(JSON.stringify(data, null, 2));

  // Query specific party's balance
  console.log(`\nQuerying balance for ${payerParty.slice(0, 30)}...`);
  const res2 = await fetch(
    `${SERVER}/balance/${encodeURIComponent(payerParty)}`,
  );

  if (!res2.ok) {
    console.error(`Failed: ${res2.status} ${await res2.text()}`);
    process.exit(1);
  }

  const data2 = await res2.json();
  console.log("Balance data received:");
  console.log(JSON.stringify(data2, null, 2));
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});
