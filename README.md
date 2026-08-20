# Canton x402 SDK

Monorepo for the `@chainsafe/x402-*` packages — x402 payments on the Canton Network. Holders of Canton Ledger API access can prepare + sign a Canton Coin transfer and hand the signed payload to a facilitator to settle; merchants can gate resources with a `402`.

## Packages

| Package | Purpose |
| --- | --- |
| `@chainsafe/x402-core` | Shared wire types, canonical requirements hashing (RFC-8785), verify primitives, network presets. No framework deps. |
| `@chainsafe/x402-server-sdk` | Payer SDK — prepare + sign a transfer with a party key + ledger access; auto-pay `fetch`; facilitator client. |
| `@chainsafe/x402-express` | Merchant middleware — `paymentRequired()` gating for Express. |

## Examples

| Example | What it shows |
| --- | --- |
| [`examples/mortgage`](examples/mortgage) | End-to-end server-to-server demo: a mortgage-app backend (payer, `x402-server-sdk`) pays a credit bureau (merchant, `x402-express`) per credit-score pull over Canton Coin, with a small UI. Configurable for LocalNet / DevNet / MainNet. |

## Development

Requires Node ≥ 20 and pnpm (see `.nvmrc` / `packageManager`).

```bash
pnpm install
pnpm build          # build all packages (dual ESM + CJS + d.ts)
pnpm test           # vitest across packages
pnpm test:coverage  # …the same suites, with coverage (see below)
pnpm typecheck      # tsc --noEmit per package
pnpm lint           # eslint
```

### Coverage

`pnpm test:coverage` runs every package's suite in one vitest pass with the v8
provider, then rolls the result up per package (run `pnpm build` first — the suites
resolve workspace deps from `dist/`):

| Output | What it is |
| --- | --- |
| `coverage/lcov-report/index.html` | HTML report, line by line. |
| `coverage/lcov.info` | lcov with repo-relative paths. |
| `coverage/summary.json` | Per-package + workspace totals; CI's baseline for the delta. |
| `coverage/summary.md` | The table CI posts on the PR. |

What's measured: each package's own `src/**`, with tests, fixtures, `dist/` and the
examples excluded — the rules live in one place, [`vitest.config.ts`](vitest.config.ts),
which also discovers the packages (`projects: ["packages/*"]`, no per-package config).
A source file no test ever imports is reported at 0% rather than skipped, so a package
with no tests at all shows up as a flagged 0% row instead of a silent pass.

CI runs this on every PR and reports it Codecov-style, in a sticky comment and on the
run's job summary:

- **Patch coverage** — of the executable lines the PR *adds*, how many a test runs, with
  the uncovered ones listed by file and line number. This is the number that answers
  "is this change tested"; the project total can't, since a PR can add untested lines
  and still move the total up.
- **Project coverage** and its delta against the base branch's last successful run, as a
  `Coverage Diff` block plus a per-package table.

lcov is uploaded as the `coverage` artifact. Patch coverage needs the PR's diff, so a
local `pnpm test:coverage` reports the project number only. (Fork PRs get the job summary
and the artifact; their read-only token can't post the comment.)

## Conventions

- **Conventional Commits** are required (`feat:`, `fix:`, `chore:`, `refactor:`, …, with optional package scope e.g. `feat(x402-core): …`). Release automation depends on it.
- Packages build to dual **ESM + CJS** with type declarations via `tsup` (shared preset in `tsup.base.ts`).

_Publishing to npm is set up separately (see the release-automation issue)._
