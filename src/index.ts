// Canton x402 SDK -- Barrel Export

// Types
export type {
  PaymentPayload,
  PaymentRequirements,
  CantonPayload,
  CreatePaymentCommand,
  VerifyResponse,
  SettleResponse,
  SupportedKind,
  PaymentObjectRequest,
  PaymentObjectResponse,
  CantonCommand,
  Command,
  CreateCommand,
  ExerciseCommand,
  ExerciseByKeyCommand,
  CreateAndExerciseCommand,
  Identifier,
  SubmitAndWaitResponse,
  Transaction,
  LedgerEvent,
  CreatedEvent,
  ExercisedEvent,
  AuthMode,
  CantonSdkConfig,
  SettleOptions,
  SettleInteractiveOptions,
  PaymentGateOptions,
  X402FetchOptions,
  FacilitatorOptions,
} from "./types.js";

export {
  CantonError,
  VerificationError,
  SettlementError,
} from "./types.js";

// Config
export { localnetConfig, devnetConfig } from "./config.js";

// Canton
export {
  type AuthProvider,
  SharedSecretAuthProvider,
  OAuth2AuthProvider,
  createAuthProvider,
} from "./canton/auth.js";
export { verify, validatePaymentCommand } from "./canton/verify.js";
export { generatePaymentObject } from "./canton/payment-object.js";
export { CantonJsonClient } from "./canton/json-client.js";
export { settleLocal, settle } from "./canton/settle.js";

// Facilitator
export { createFacilitatorRouter, startFacilitator, NonceStore } from "./facilitator/index.js";

// Middleware
export { paymentRequired } from "./middleware/index.js";

// Client
export { createX402Fetch } from "./client/index.js";
