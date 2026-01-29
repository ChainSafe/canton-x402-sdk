/**
 * Token-Gated Document Access Client
 *
 * Lists available docs (free), then downloads one using x402 auto-payment.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "../../shared/env.js";
import { createX402Fetch } from "canton-x402-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { config, payerParty } = loadEnv(join(__dirname, "..", ".env"));

const SERVER = "http://localhost:4010";
const x402Fetch = createX402Fetch({ config, payerParty });

async function main() {
  console.log("Canton x402 SDK -- Token-Gated Document Client\n");

  // 1. List docs (free -- no payment needed)
  console.log("Listing available documents...");
  const listRes = await fetch(`${SERVER}/docs`);
  const { documents } = (await listRes.json()) as {
    documents: { id: string; title: string }[];
  };
  for (const doc of documents) {
    console.log(`  [${doc.id}] ${doc.title}`);
  }

  // 2. Download a document (payment gated -- x402Fetch handles 402 automatically)
  console.log("\nDownloading term-sheet (will auto-pay 0.10 CC)...");
  const docRes = await x402Fetch(`${SERVER}/docs/term-sheet`);

  if (!docRes.ok) {
    console.error(`Failed: ${docRes.status} ${await docRes.text()}`);
    process.exit(1);
  }

  const doc = await docRes.json();
  console.log("\nDocument received:");
  console.log(JSON.stringify(doc, null, 2));
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});
