pragma circom 2.1.9;

// merge_notes: joins two notes of the same owner into one (step 9).
// The treasury merges its fee notes before collecting them, so a collection
// shows only an aggregate; traders can merge their own notes too.
//
// Public: root. Outputs: the two nullifiers and the merged note's commitment
// (amount = a + b, same owner, new salt). Spending the same note twice gives
// the same nullifier twice, which the vault refuses.

include "notes.circom";

template MergeNotes(LEVELS) {
    signal input root;
    signal input ownerSecret;
    signal input amountA;
    signal input saltA;
    signal input pathElementsA[LEVELS];
    signal input pathIndicesA[LEVELS];
    signal input amountB;
    signal input saltB;
    signal input pathElementsB[LEVELS];
    signal input pathIndicesB[LEVELS];
    signal input mergedSalt;

    signal output nullifierA;
    signal output nullifierB;
    signal output merged;

    component a = SpendNote(LEVELS);
    component b = SpendNote(LEVELS);
    a.root <== root;
    b.root <== root;
    a.ownerSecret <== ownerSecret;
    b.ownerSecret <== ownerSecret;
    a.amount <== amountA;
    b.amount <== amountB;
    a.salt <== saltA;
    b.salt <== saltB;
    for (var i = 0; i < LEVELS; i++) {
        a.pathElements[i] <== pathElementsA[i];
        a.pathIndices[i] <== pathIndicesA[i];
        b.pathElements[i] <== pathElementsB[i];
        b.pathIndices[i] <== pathIndicesB[i];
    }
    nullifierA <== a.nullifier;
    nullifierB <== b.nullifier;

    component m = NoteCommitment();
    m.amount <== amountA + amountB;         // both < 2^64 (SpendNote checks)
    m.ownerHash <== a.ownerHash;
    m.salt <== mergedSalt;
    merged <== m.out;
}

component main {public [root]} = MergeNotes(20);
