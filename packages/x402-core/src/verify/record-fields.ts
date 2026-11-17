/**
 * Reading one field out of a Daml record, the way the ENGINE binds it.
 *
 * Daml binds a record BY LABEL only when EVERY field carries one. A single
 * unlabeled field puts the whole record in DECLARATION ORDER, and each label
 * that is still present is then checked against the name declared at its own
 * index rather than searched for elsewhere. `value.proto` states the same
 * rule: with all keys present the order does not matter; with any key omitted
 * the order MUST match the declaration.
 *
 * READING `some` WHERE THE ENGINE READS `every` inverts that, and hands the
 * choice of mode to whoever wrote the blob. Blanking ONE label then sends the
 * reader down the label path while the engine stays positional, and every
 * field looked up by name comes back undefined — a field silently DROPPED
 * rather than a blob refused.
 *
 * ONE IMPLEMENTATION, DELIBERATELY. This rule was written twice — once for the
 * transaction's own records and once for a disclosed contract's — and the two
 * copies drifted: the second kept the inverted quantifier after the first was
 * corrected, in the reader that decides whose preapproval a delivery spends.
 * Both call sites now share this, so there is one place for the rule to be
 * right or wrong.
 *
 * Generic over the value type because the two readers carry different ones: a
 * protobuf `Value` while walking the transaction, an already-flattened string
 * once a disclosure's scalar leaves have been read.
 */
export function recordField<V>(
  fields: readonly { label: string; value?: V }[],
  label: string,
  index: number,
): V | undefined {
  if (fields.every((f) => f.label !== "")) return fields.find((f) => f.label === label)?.value;
  const field = fields[index];
  if (!field) return undefined;
  // Declaration order binds here, so a label that disagrees with the name
  // declared at this index is a contradiction, not a pointer somewhere else.
  if (field.label !== "" && field.label !== label) return undefined;
  return field.value;
}
