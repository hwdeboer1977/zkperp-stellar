// The vault's commitment tree (notes and positions), rebuilt from the leaves
// the vault stores, to make Merkle paths for proofs. The computed root is
// checked against the vault (is_known_root) by the callers.
import { crypto } from "./keeper.mjs";

export const DEPTH = 20;

export class Tree {
  static async fromLeaves(leaves) {
    const { poseidon, F } = await crypto();
    const h = (a, b) => F.toObject(poseidon([a, b]));
    const zeros = [0n];
    for (let i = 0; i < DEPTH; i++) zeros.push(h(zeros[i], zeros[i]));
    const layers = [leaves.map(BigInt)];
    for (let i = 0; i < DEPTH; i++) {
      const prev = layers[i], next = [];
      for (let j = 0; j < Math.ceil(prev.length / 2); j++) next.push(h(prev[2 * j], prev[2 * j + 1] ?? zeros[i]));
      layers.push(next);
    }
    const t = new Tree();
    Object.assign(t, { layers, zeros, root: layers[DEPTH][0] ?? zeros[DEPTH] });
    return t;
  }

  path(index) {
    const pathElements = [], pathIndices = [];
    let idx = index;
    for (let i = 0; i < DEPTH; i++) {
      pathElements.push(this.layers[i][idx ^ 1] ?? this.zeros[i]);
      pathIndices.push(idx & 1);
      idx >>= 1;
    }
    return { pathElements, pathIndices };
  }
}
