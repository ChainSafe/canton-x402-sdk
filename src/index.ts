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
  InsufficientBalanceError,
} from "./types.js";

// Config
export { localnetConfig, devnetConfig, mainnetConfig, validateConfig } from "./config.js";

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

// Validation
export {
  isValidPartyId,
  isValidAmount,
  isValidResourceId,
} from "./canton/validation.js";

// Billing
export {
  queryPaymentsFromChain,
  queryChargesFromChain,
  createChargeReceipt,
  computeBalance,
  createChargeManager,
  findChargeManager,
  getOrCreateChargeManager,
  type ChargeRecord,
  type PaymentRecord,
  type BalanceResult,
  type BalanceOptions,
  type CreateChargeOptions,
  type CreateChargeResult,
  type QueryResult,
} from "./canton/billing.js";

// Middleware
export { paymentRequired } from "./middleware/index.js";

// Client
export { createX402Fetch } from "./client/index.js";

// Logger
export {
  type Logger,
  JsonLogger,
  noopLogger,
  redactSensitive,
} from "./logger.js";
