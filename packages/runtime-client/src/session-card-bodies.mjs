const fields = { tools: ["args", "result"], thinking: ["text"] };

export function sessionCardBody(kind, card) {
  if (!fields[kind]) throw new Error("Invalid card body kind");
  return Object.fromEntries(fields[kind]
    .filter(key => Object.hasOwn(card, key))
    .map(key => [key, card[key]]));
}

export function withoutSessionCardBody(kind, card) {
  const result = { ...card };
  for (const key of fields[kind] || []) delete result[key];
  return result;
}

export function hydratedSessionCard(card, body) {
  const { bodyRef, bodySessionId, bodyKind, bodyBytes, bodyHydratedRef, ...header } = card;
  return { ...header, ...body };
}
