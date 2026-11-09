import { decodePreparedTransaction } from "@canton-network/core-tx-visualizer";

/** Keep pre-auth decoding and hashing comfortably below the facilitator's 1 MiB body limit. */
export const MAX_PREPARED_TRANSACTION_BYTES = 256 * 1024;
export const MAX_PREPARED_TRANSACTION_BASE64_LENGTH =
  4 * Math.ceil(MAX_PREPARED_TRANSACTION_BYTES / 3);

/** Bounds both the iterative validation work and the recursive work in the upstream hasher. */
export const MAX_PREPARED_TRANSACTION_NODES = 1_024;
export const MAX_PREPARED_TRANSACTION_INPUT_CONTRACTS = 1_024;

export type PreparedTransactionGuardFailure =
  | "size_limit"
  | "undecodable"
  | "node_limit"
  | "node_seed_limit"
  | "input_contract_limit"
  | "duplicate_node_id"
  | "duplicate_reference"
  | "missing_node"
  | "unreachable_node";

export type PreparedTransactionGuardResult =
  { ok: true } | { ok: false; reason: PreparedTransactionGuardFailure };

type PreparedTransactionNode = NonNullable<
  ReturnType<typeof decodePreparedTransaction>["transaction"]
>["nodes"][number];

/** Children traversed recursively by core-tx-visualizer's V2 hasher. */
function nodeChildren(node: PreparedTransactionNode): readonly string[] {
  if (node.versionedNode.oneofKind !== "v1") return [];

  const nodeType = node.versionedNode.v1.nodeType;
  if (nodeType.oneofKind === "exercise") return nodeType.exercise.children;
  if (nodeType.oneofKind === "rollback") return nodeType.rollback.children;
  return [];
}

/**
 * Bound and validate the transaction graph before handing it to the recursive
 * canonical hasher. Canton transactions must form a forest: every root/child
 * reference is unique, every reference resolves, and every declared node is
 * reachable from exactly one root.
 */
export function guardPreparedTransaction(
  preparedTransaction: string,
): PreparedTransactionGuardResult {
  // Check before base64 decoding so an attacker cannot force a large allocation.
  const padding = preparedTransaction.endsWith("==")
    ? 2
    : preparedTransaction.endsWith("=")
      ? 1
      : 0;
  const decodedLength = Math.floor((preparedTransaction.length * 3) / 4) - padding;
  if (
    preparedTransaction.length > MAX_PREPARED_TRANSACTION_BASE64_LENGTH ||
    decodedLength > MAX_PREPARED_TRANSACTION_BYTES
  ) {
    return { ok: false, reason: "size_limit" };
  }

  let decoded: ReturnType<typeof decodePreparedTransaction>;
  try {
    decoded = decodePreparedTransaction(preparedTransaction);
  } catch {
    return { ok: false, reason: "undecodable" };
  }

  const transaction = decoded.transaction;
  if (!transaction) return { ok: false, reason: "undecodable" };
  if (transaction.nodes.length > MAX_PREPARED_TRANSACTION_NODES) {
    return { ok: false, reason: "node_limit" };
  }
  // Canton emits at most one seed per node; the hasher scans all seeds for each node.
  if (transaction.nodeSeeds.length > transaction.nodes.length) {
    return { ok: false, reason: "node_seed_limit" };
  }
  // Each input contract costs its own sha256 in the hasher.
  if ((decoded.metadata?.inputContracts.length ?? 0) > MAX_PREPARED_TRANSACTION_INPUT_CONTRACTS) {
    return { ok: false, reason: "input_contract_limit" };
  }

  const nodes = new Map<string, (typeof transaction.nodes)[number]>();
  for (const node of transaction.nodes) {
    if (nodes.has(node.nodeId)) return { ok: false, reason: "duplicate_node_id" };
    nodes.set(node.nodeId, node);
  }

  // Mark a reference when queued, not when visited. This rejects cycles,
  // duplicate roots, duplicate children, and DAG-style shared children.
  const referenced = new Set<string>();
  const stack: string[] = [];
  for (const root of transaction.roots) {
    if (referenced.has(root)) return { ok: false, reason: "duplicate_reference" };
    referenced.add(root);
    stack.push(root);
  }

  let visitedCount = 0;
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (nodeId === undefined) break;

    const node = nodes.get(nodeId);
    if (!node) return { ok: false, reason: "missing_node" };

    visitedCount += 1;

    for (const child of nodeChildren(node)) {
      if (referenced.has(child)) return { ok: false, reason: "duplicate_reference" };
      referenced.add(child);
      stack.push(child);
    }
  }

  if (visitedCount !== transaction.nodes.length) {
    return { ok: false, reason: "unreachable_node" };
  }
  return { ok: true };
}
