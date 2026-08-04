// Provision the mortgage demo against a running Splice LocalNet + facilitator, then
// write examples/mortgage/.env. Onboards two external parties on the app-provider
// participant — a funded PAYER (the lender's backend) and a receivable BUREAU — via
// the validator admin API, mirroring the facilitator's e2e harness. Self-contained:
// pure Node crypto (Ed25519 + HS256), no extra deps.
//
// Prereq: LocalNet + the facilitator running (facilitator in FACILITATOR_MODE=single-tenant,
// so no merchant API key is needed). Then:
//
//   node examples/mortgage/scripts/bootstrap-localnet.mjs
//   # → writes examples/mortgage/.env, ready for `pnpm --filter … dev` or docker-compose
//
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign as edSign, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── LocalNet endpoints (app-provider participant) + unsafe dev auth ─────────
const LEDGER_URL = process.env.E2E_LEDGER_URL ?? "http://localhost:3975";
const VALIDATOR_URL = process.env.E2E_VALIDATOR_URL ?? "http://localhost:3903";
const FACILITATOR_URL = process.env.E2E_FACILITATOR_URL ?? "http://localhost:8402";
const AMULET_REGISTRY_URL = `${VALIDATOR_URL}/api/validator/v0/scan-proxy`;
const AUTH_SECRET = "unsafe";
const AUTH_AUDIENCE = "https://canton.network.global";
const ADMIN_USER = "ledger-api-user"; // validator operator (admin + actAs/readAs)
const WALLET_USER = "app-provider"; // wallet-owning user (tap / preapproval-send)
const PAYER_FUNDING_CC = "100.0";

const b64url = (s) => Buffer.from(s).toString("base64url");
const toB64 = (b64u) => Buffer.from(b64u, "base64url").toString("base64");
const toHex = (b64u) => Buffer.from(b64u, "base64url").toString("hex");

/** Mint the HS256 "unsafe" JWT LocalNet's Canton accepts, for a subject (user). */
function mintToken(sub) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ sub, aud: AUTH_AUDIENCE, exp: 9999999999 }));
  const s = createHmac("sha256", AUTH_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
const adminToken = () => mintToken(ADMIN_USER);

async function httpJson(url, { method = "GET", token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/** Read the synchronizer id + DSO party from the running network. */
async function discover() {
  const cs = await httpJson(`${LEDGER_URL}/v2/state/connected-synchronizers`, { token: adminToken() });
  const synchronizerId = cs.connectedSynchronizers?.[0]?.synchronizerId;
  if (!synchronizerId) throw new Error("no connected synchronizer");
  const namespace = synchronizerId.split("::")[1];
  return { networkId: `canton:${namespace}`, dsoParty: `DSO::${namespace}` };
}

/** Onboard a fresh Ed25519 external party via the validator topology flow. */
async function onboardExternalParty(hint) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64url = publicKey.export({ format: "jwk" }).x;
  const seedB64url = privateKey.export({ format: "jwk" }).d;
  const token = adminToken();
  const base = `${VALIDATOR_URL}/api/validator/v0/admin/external-party/topology`;

  const gen = await httpJson(`${base}/generate`, {
    method: "POST",
    token,
    body: { party_hint: hint, public_key: toHex(pubB64url) },
  });
  const signed = gen.topology_txs.map((tx) => ({
    topology_tx: tx.topology_tx,
    signed_hash: edSign(null, Buffer.from(tx.hash, "hex"), privateKey).toString("hex"),
  }));
  await httpJson(`${base}/submit`, {
    method: "POST",
    token,
    body: { public_key: toHex(pubB64url), signed_topology_txs: signed },
  });
  return {
    partyId: gen.party_id,
    publicKey: toB64(pubB64url),
    privateKey: toB64(seedB64url),
    keyObject: privateKey,
  };
}

/** Let the hosting participant act as the party (needed to prepare submissions for it). */
async function grantActAs(partyId) {
  await httpJson(`${LEDGER_URL}/v2/users/${ADMIN_USER}/rights`, {
    method: "POST",
    token: adminToken(),
    body: { userId: ADMIN_USER, rights: [{ kind: { CanActAs: { value: { party: partyId } } } }] },
  });
}

/** Give the party a TransferPreapproval so it can receive CC without accepting each transfer. */
async function setupPreapproval(party) {
  const token = adminToken();
  const base = `${VALIDATOR_URL}/api/validator/v0/admin/external-party/setup-proposal`;
  const created = await httpJson(base, { method: "POST", token, body: { user_party_id: party.partyId } });
  const prepared = await httpJson(`${base}/prepare-accept`, {
    method: "POST",
    token,
    body: { contract_id: created.contract_id, user_party_id: party.partyId },
  });
  await httpJson(`${base}/submit-accept`, {
    method: "POST",
    token,
    body: {
      submission: {
        party_id: party.partyId,
        transaction: prepared.transaction,
        signed_tx_hash: edSign(null, Buffer.from(prepared.tx_hash, "hex"), party.keyObject).toString("hex"),
        public_key: Buffer.from(party.publicKey, "base64").toString("hex"),
      },
    },
  });
}

/** Send CC to a (preapproved) receiver from the participant's wallet. */
async function fundParty(receiverPartyId, amount) {
  await httpJson(`${VALIDATOR_URL}/api/validator/v0/wallet/transfer-preapproval/send`, {
    method: "POST",
    token: mintToken(WALLET_USER),
    body: {
      receiver_party_id: receiverPartyId,
      amount,
      deduplication_id: `mortgage-demo-fund-${receiverPartyId.slice(-8)}`,
      description: "mortgage demo payer funding",
    },
  });
}

/** Onboard + grant actAs + preapproval (a "first-class" party). */
async function provisionParty(hint) {
  const party = await onboardExternalParty(hint);
  await grantActAs(party.partyId);
  await setupPreapproval(party);
  return party;
}

async function main() {
  const facOk = await fetch(`${FACILITATOR_URL}/health`).then((r) => r.ok).catch(() => false);
  const ledgerOk = await fetch(`${LEDGER_URL}/v2/version`).then((r) => r.ok).catch(() => false);
  if (!facOk || !ledgerOk) {
    throw new Error(`LocalNet/facilitator not reachable (ledger ${LEDGER_URL}, facilitator ${FACILITATOR_URL}). Start them first.`);
  }

  const { networkId, dsoParty } = await discover();
  console.error(`• network ${networkId}`);
  console.error("• provisioning payer (onboard + preapproval + actAs)…");
  const payer = await provisionParty("mortgage-payer");
  console.error(`• funding payer ${PAYER_FUNDING_CC} CC…`);
  await fundParty(payer.partyId, PAYER_FUNDING_CC);
  console.error("• provisioning bureau (onboard + preapproval to receive)…");
  const bureau = await provisionParty("credit-bureau");

  const env = [
    "# Generated by bootstrap-localnet.mjs — LocalNet demo config.",
    "NETWORK=localnet",
    `NETWORK_ID=${networkId}`,
    `DSO_PARTY=${dsoParty}`,
    `AMULET_REGISTRY_URL=${AMULET_REGISTRY_URL}`,
    "PRICE_CC=0.05",
    "",
    `FACILITATOR_URL=${FACILITATOR_URL}`,
    "FACILITATOR_API_KEY=",
    `BUREAU_PARTY=${bureau.partyId}`,
    "BUREAU_PORT=4001",
    "",
    "BUREAU_URL=http://localhost:4001",
    `LEDGER_CLIENT_URL=${LEDGER_URL}`,
    `PAYER_PARTY_ID=${payer.partyId}`,
    `PAYER_PUBLIC_KEY=${payer.publicKey}`,
    `PAYER_PRIVATE_KEY=${payer.privateKey}`,
    "APPROVE_MIN_SCORE=700",
    "MAX_LOAN=2000000",
    "MAX_LTV=0.9",
    "MORTGAGE_BACKEND_PORT=4002",
    "",
    "UI_PORT=5173",
    "VITE_DEV_API=http://localhost:4002",
    "",
  ].join("\n");

  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  writeFileSync(envPath, env);
  console.error(`\n✓ wrote ${envPath}`);
  console.error("  Next: pnpm --filter … dev  (or: docker compose -f docker-compose.yml -f docker-compose.localnet.yml up --build)");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
