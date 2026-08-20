# AGENTS.md

This repo follows the **ChainSafe Engineering Handbook** — https://github.com/ChainSafe/engineering-handbook.
It is the canonical source for how we work (the operator-first contract, gates, language
standards, PR/review workflow). This file only adds repo-specific context; when the two
conflict, the handbook wins.

## Load order — pull the minimum on demand, do NOT bulk-load

1. Handbook entrypoint: `AGENTS.md`.
2. `operating-model/collaborator-statement.md` — the operator-first contract. Load before any non-trivial task.
3. `operating-model/gates-and-escalation.md` — when to stop (production, secrets, irreversible writes, `git push`/merge, opening a PR or issue on someone's behalf).
4. This repo is **TypeScript**: for code work load `languages/typescript/{developer,idioms,gotchas,reviewer}.md`, or invoke the packaged skills `chainsafe-typescript-developer` / `chainsafe-typescript-reviewer`.
5. For PR-shaped work: the `chainsafe-research-plan-implement` skill (research → plan → implement, with a human-approved plan gating any code change).

Discover handbook pages via **GitHub MCP** when it's connected (preferred — follow the cross-references); otherwise fetch `https://handbook.chainsafe.io/llms.txt` and pull the raw markdown URLs you need. Fetch the actual pages — don't paraphrase from memory.

## Non-negotiables (see the handbook's `invariants/`)

- No silent edits, no fabricated APIs, no committed secrets.
- Never push directly to `main`; open a PR (OneFlow) and let the operator merge.
- One reviewable PR per change; propose a split rather than shipping an oversized PR.

---

## Repo-specific: canton-x402-sdk

The x402 SDK — a **pnpm monorepo** of published TypeScript packages.

- **Package manager:** pnpm (`packages/*` + `examples/*/*` workspaces). Node from `.nvmrc`.
- **Commands:**
  - Install: `pnpm install --frozen-lockfile`
  - Build (topological — packages resolve workspace deps from `dist/`, so build first): `pnpm build`
  - Typecheck: `pnpm typecheck`
  - Lint: `pnpm lint`
  - Tests: `pnpm test` (`pnpm -r test`, vitest `--passWithNoTests`)
  - CI runs build → typecheck → lint → test (`.github/workflows/ci.yml`).
- **Release:** Changesets. **Every PR touching `packages/**` must carry a changeset** (`pnpm changeset`, or `pnpm changeset --empty` for no-release changes) — CI enforces it. Packages publish via `pnpm changeset publish` on merge of the Version PR.
- **Packages:** `@chainsafe/x402-{core,client,express,server-sdk}`.
  - `x402-core` — shared types, verify, X-PAYMENT codec.
  - `x402-client` — `FacilitatorClient` (verify/settle/supported).
  - `x402-express` — merchant middleware (`paymentRequired`).
  - `x402-server-sdk` — payer SDK (`CantonX402Payer`, `createX402Fetch`).
- **Direction:** reuse the official `@canton-network/wallet-sdk` for Canton access — **do not hand-roll a Canton client**.
- `examples/mortgage/*` is a runnable payer + merchant pair for local verification.
