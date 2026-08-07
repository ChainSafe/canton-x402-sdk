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
pnpm build       # build all packages (dual ESM + CJS + d.ts)
pnpm test        # vitest across packages
pnpm typecheck   # tsc --noEmit per package
pnpm lint        # eslint
```

## Conventions

- **Conventional Commits** are required (`feat:`, `fix:`, `chore:`, `refactor:`, …, with optional package scope e.g. `feat(x402-core): …`). Release automation depends on it.
- Packages build to dual **ESM + CJS** with type declarations via `tsup` (shared preset in `tsup.base.ts`).

_Publishing to npm is set up separately (see the release-automation issue)._
