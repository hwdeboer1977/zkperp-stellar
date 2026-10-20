// Where the circuits' proving files (.wasm, .zkey, .vkey.json) are found.
// Node: circuits/keys/ on disk. Browser: set globalThis.ZKPERP_KEYS_URL (e.g.
// "/zk/") before proving and the files are fetched from there.
export function keyPath(file) {
  if (globalThis.ZKPERP_KEYS_URL) return `${globalThis.ZKPERP_KEYS_URL}${file}`;
  // A variable, not a literal: bundlers would otherwise copy every key file.
  const rel = "../keys/" + file;
  return decodeURIComponent(new URL(rel, import.meta.url).pathname);
}
