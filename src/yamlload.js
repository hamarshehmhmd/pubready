// Load YAML into plain JS values while remembering the source line of every mapping key / sequence item.
import { parseDocument, LineCounter, isMap, isSeq, isScalar, isAlias, isPair } from "yaml";

export const LINES = Symbol("lines");

export function loadYaml(text) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: false, merge: true });
  if (doc.errors && doc.errors.length) {
    const e = doc.errors[0];
    const err = new Error(e.message.split("\n")[0]);
    err.line = e.linePos && e.linePos[0] ? e.linePos[0].line : undefined;
    throw err;
  }
  const lineOf = (node) => (node && node.range ? lineCounter.linePos(node.range[0]).line : undefined);
  const seen = new Set();
  function conv(node) {
    if (node == null) return null;
    if (isAlias(node)) {
      const target = node.resolve(doc);
      if (!target || seen.has(target)) return null;
      seen.add(target);
      try { return conv(target); } finally { seen.delete(target); }
    }
    if (isScalar(node)) return node.value;
    if (isMap(node)) {
      const out = {};
      const lines = {};
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const k = pair.key && isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        if (k === "<<" || typeof (pair.key && pair.key.value) === "symbol") {
          const merged = conv(pair.value);
          for (const src of Array.isArray(merged) ? merged : [merged]) {
            if (src && typeof src === "object") {
              for (const [mk, mv] of Object.entries(src)) if (!(mk in out)) { out[mk] = mv; lines[mk] = (src[LINES] || {})[mk]; }
            }
          }
          continue;
        }
        out[k] = conv(pair.value);
        lines[k] = lineOf(pair.key);
      }
      Object.defineProperty(out, LINES, { value: lines, enumerable: false });
      return out;
    }
    if (isSeq(node)) {
      const arr = node.items.map(conv);
      Object.defineProperty(arr, LINES, { value: node.items.map(lineOf), enumerable: false });
      return arr;
    }
    return node.toJSON ? node.toJSON() : null;
  }
  return conv(doc.contents);
}

export function lineOfKey(obj, key) {
  return obj && obj[LINES] ? obj[LINES][key] : undefined;
}

export function lineOfItem(arr, i) {
  return arr && arr[LINES] ? arr[LINES][i] : undefined;
}
