---
"@chainsafe/x402-core": patch
---

`decodePreparedTransaction` requires the transaction to be a single tree whose
root is the transfer, and refuses more than one transfer in it.

A payment is one command, so its transaction is one tree and that tree's root
is the transfer being paid for. Before this, a transfer could sit beside
another root or beneath another exercise, and a second transfer was silently
ignored — so a facilitator could relay, and pay the traffic fee for, legs the
verifier never looked at, while the input-sufficiency check covered one
transfer where execution needed them all.

Not a signature bypass: every node in the tree is covered by the signed hash,
so the payer authorised all of it. This is about the decoder answering a
narrower question than the verifier is asking.

Consequences of the transfer — the children its own choice produces — are
unaffected and still decode. Canton does not produce a payment shaped any other
way, so real traffic is unaffected.
