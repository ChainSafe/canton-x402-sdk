---
"@chainsafe/x402-express": minor
---

Verify rejections now forward the facilitator's `extensions.detail` as `details` in the 402 body, as settle rejections already did. New opt-in `onReject` option reports every rejected payment (402) and facilitator/middleware failure (502/500), including the facilitator's full `extensions`, so merchants can log why a payment failed.
