/** Legacy writers sometimes concatenated two markers, including on a role
 * header. Recognize that presentation without rewriting the user's document. */
export function isCardMarkerLine(value: string): boolean {
  const line = String(value || "").replace(
    /^\s*assistant\s+(?:<!--\s*zion-assistant:id=[^>\s]+\s*-->\s*)?/, ""
  );
  if (/^\s*调用\s+[^\n<]{1,300}\s*$/.test(line)) return true;
  const marker = /(?:调用[ \t]+[^\n<]{1,300}?[ \t]*<!--[ \t]*zion-tool:id=[^>\s]+[ \t]*-->|思考[ \t]*<!--[ \t]*zion-thinking:id=[^>\s]+[ \t]*-->)/g;
  let count = 0;
  const remainder = line.replace(marker, () => { count++; return ""; });
  return count > 0 && remainder.trim() === "";
}
