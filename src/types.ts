// Canton x402 SDK -- Type Definitions

// ─── x402 Protocol Types ───────────────────────────────────────────────────

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: CantonPayload;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset?: string;
  outputSchema?: unknown;
  extra?: Record<string, unknown>;
}

export interface CantonPayload {
  command: CreatePaymentCommand;
  signature?: string;
}

export interface CreatePaymentCommand {
  payer: string;
  payee: string;
  amount: string;
  currency: string;
  resourceId: string;
  nonce: string;
}

// ─── Response Types ────────────────────────────────────────────────────────

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  transactionId?: string;
  error?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

// ─── Payment Object Types ──────────────────────────────────────────────────

export interface PaymentObjectRequest {
  amount: string;
  merchantParty: string;
  payerParty: string;
  resource: string;
  description?: string;
  expiresAt?: string;
  x402Signature?: string;
  notificationUrl?: string;
  holdingCids?: string[];
}

export interface PaymentObjectResponse {
  paymentObject: {
    amount: string;
    merchantParty: string;
    payerParty: string;
    expiresAt: string;
    resource: string;
    description?: string;
    facilitatorFee: string;
    totalAmount: string;
    transferFactory: {
      contractId: string;
      disclosedContracts: unknown[];
    };
    choiceContext: unknown;
  };
  paymentId: string;
  status: "ready" | "pending" | "completed";
  notificationUrl?: string;
}

// ─── Canton Ledger API Types ───────────────────────────────────────────────

export interface CantonCommand {
  workflowId?: string;
  userId: string;
  commandId: string;
  commands: Command[];
  actAs: string[];
  readAs?: string[];
  submissionId?: string;
  synchronizerId?: string;
}

export interface Command {
  create?: CreateCommand;
  exercise?: ExerciseCommand;
  exerciseByKey?: ExerciseByKeyCommand;
  createAndExercise?: CreateAndExerciseCommand;
}

export interface CreateCommand {
  templateId: Identifier;
  createArguments: Record<string, unknown>;
}

export interface ExerciseCommand {
  templateId: Identifier;
  contractId: string;
  choice: string;
  choiceArgument: unknown;
}

export interface ExerciseByKeyCommand {
  templateId: Identifier;
  contractKey: unknown;
  choice: string;
  choiceArgument: unknown;
}

export interface CreateAndExerciseCommand {
  templateId: Identifier;
  createArguments: Record<string, unknown>;
  choice: string;
  choiceArgument: unknown;
}

export interface Identifier {
  packageId?: string;
  moduleName: string;
  entityName: string;
}

export interface SubmitAndWaitResponse {
  updateId: string;
  completionOffset: string;
}

export interface Transaction {
  updateId: string;
  commandId: string;
  workflowId: string;
  effectiveAt: string;
  events: LedgerEvent[];
  offset: string;
  synchronizerId: string;
}

export interface LedgerEvent {
  created?: CreatedEvent;
  exercised?: ExercisedEvent;
  CreatedEvent?: CreatedEvent;
  ExercisedEvent?: ExercisedEvent;
}

export interface CreatedEvent {
  eventId: string;
  contractId: string;
  templateId: Identifier | string;
  createArguments: Record<string, unknown>;
  witnessParties: string[];
}

export interface ExercisedEvent {
  eventId: string;
  contractId: string;
  templateId: Identifier | string;
  choice: string;
  choiceArgument: Record<string, unknown>;
  actingParties: string[];
  consuming: boolean;
  witnessParties: string[];
  childEventIds: string[];
  exerciseResult: unknown;
}

// ─── SDK Config Types ──────────────────────────────────────────────────────

export type AuthMode =
  | { type: "shared-secret"; secret: string; userId: string; audience?: string }
  | {
      type: "oauth2";
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      audience?: string;
      scope?: string;
    };

export interface CantonSdkConfig {
  network: string;
  ledgerApiUrl: string;
  scanProxyUrl: string;
  dsoParty: string;
  auth: AuthMode;
  spliceHoldingPackageId?: string;
}

export interface SettleOptions {
  payerParty: string;
  payeeParty: string;
  amount: string;
  resourceId: string;
}

export interface SettleInteractiveOptions extends SettleOptions {
  privateKey: string;      // base64-encoded Ed25519 private key
  keyFingerprint: string;  // Key fingerprint for signing
}

export interface PaymentGateOptions {
  payTo: string;
  amount: string;
  network?: string;
  asset?: string;
  facilitatorUrl: string;
  description?: string;
  getPrice?: (req: unknown) => string;
}

export interface X402FetchOptions {
  config: CantonSdkConfig;
  payerParty: string;
  facilitatorUrl?: string;
  privateKey?: string;
  keyFingerprint?: string;
}

export interface FacilitatorOptions {
  config: CantonSdkConfig;
  networks?: string[];
}

// ─── Error Types ───────────────────────────────────────────────────────────

export class CantonError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CantonError";
  }
}

export class VerificationError extends Error {
  constructor(
    message: string,
    public reason: string,
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

export class SettlementError extends Error {
  constructor(
    message: string,
    public reason: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "SettlementError";
  }
}
