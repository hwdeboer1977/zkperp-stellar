pragma circom 2.1.9;

// Shared templates for shielded notes (step 6).
//
// A note is collateral the vault holds privately:
//   inner      = Poseidon(ownerHash, salt)          (the depositor supplies this)
//   commitment = Poseidon(amount, inner)            (the vault recomputes it)
//   nullifier  = Poseidon(salt, leafIndex)          (published when spent)
// ownerHash = Poseidon(ownerSecret). Notes and positions share one Merkle tree,
// so leaf indices are unique and so are nullifiers.

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

template NoteCommitment() {
    signal input amount;
    signal input ownerHash;
    signal input salt;
    signal output out;
    component inner = Poseidon(2);
    inner.inputs[0] <== ownerHash;
    inner.inputs[1] <== salt;
    component c = Poseidon(2);
    c.inputs[0] <== amount;
    c.inputs[1] <== inner.out;
    out <== c.out;
}

// Root of a Poseidon(2) Merkle tree from a leaf and its path; also the leaf index.
template MerkleRoot(LEVELS) {
    signal input leaf;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];   // 0: node is a left child, 1: right child
    signal output root;
    signal output index;

    component h[LEVELS];
    signal cur[LEVELS + 1];
    signal left[LEVELS];
    signal right[LEVELS];
    var idx = 0;
    cur[0] <== leaf;
    for (var i = 0; i < LEVELS; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        // left = bit ? sibling : cur;  right = bit ? cur : sibling
        left[i] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        cur[i + 1] <== h[i].out;
        idx += pathIndices[i] * (1 << i);
    }
    root <== cur[LEVELS];
    index <== idx;
}

// Spends a note: proves it is in the tree under `root`, owned by
// `ownerSecret`, and outputs its nullifier and owner hash.
template SpendNote(LEVELS) {
    signal input root;
    signal input amount;
    signal input ownerSecret;
    signal input salt;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];
    signal output nullifier;
    signal output ownerHash;

    component amountBits = Num2Bits(64);
    amountBits.in <== amount;

    component owner = Poseidon(1);
    owner.inputs[0] <== ownerSecret;
    ownerHash <== owner.out;

    component note = NoteCommitment();
    note.amount <== amount;
    note.ownerHash <== owner.out;
    note.salt <== salt;

    component tree = MerkleRoot(LEVELS);
    tree.leaf <== note.out;
    for (var i = 0; i < LEVELS; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    component n = Poseidon(2);
    n.inputs[0] <== salt;
    n.inputs[1] <== tree.index;
    nullifier <== n.out;
}
