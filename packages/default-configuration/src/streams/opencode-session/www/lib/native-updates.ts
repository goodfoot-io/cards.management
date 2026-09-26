/**
 * Persistent source-backed chains for inspectable OpenCode native JSONL updates.
 * @summary Lazy retained native update lines
 * @module streams/opencode-session/www/lib/native-updates
 */

/** One original JSONL line linked to earlier updates without copying or joining them. */
export interface OpencodeNativeUpdates {
  readonly line: string;
  readonly lineNumber: number;
  readonly previous?: OpencodeNativeUpdates;
  readonly count: number;
}

/** Appends one original source line in constant time.
 * @param previous - Previous immutable update chain tail.
 * @param line - Original JSONL source line.
 * @param lineNumber - Absolute source coordinate of the original line.
 * @returns New chain tail retaining the source string by reference.
 */
export function appendOpencodeNativeUpdate(
  previous: OpencodeNativeUpdates | undefined,
  line: string,
  lineNumber: number
): OpencodeNativeUpdates {
  return { line, lineNumber, previous, count: (previous?.count ?? 0) + 1 };
}

/** Materializes source lines only when an opened native-details disclosure is rendered.
 * @param tail - Latest update in the immutable chain.
 * @returns Original JSONL lines in source order.
 */
export function opencodeNativeUpdateLines(tail: OpencodeNativeUpdates): readonly string[] {
  return opencodeNativeUpdateEntries(tail).map((update) => update.line);
}

/** Materializes source update references only when their containing details are opened.
 * @param tail - Latest update in the immutable chain.
 * @returns Original update nodes in source order, retaining stable source coordinates.
 * @throws When the chain contains fewer entries than its recorded count.
 */
export function opencodeNativeUpdateEntries(tail: OpencodeNativeUpdates): readonly OpencodeNativeUpdates[] {
  const entries = new Array<OpencodeNativeUpdates>(tail.count);
  let update: OpencodeNativeUpdates | undefined = tail;
  for (let index = tail.count - 1; index >= 0; index--) {
    if (!update) throw new Error('OpenCode native update chain is incomplete');
    entries[index] = update;
    update = update.previous;
  }
  return entries;
}
