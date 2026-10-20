pragma circom 2.1.9;

// withdraw_note: turns (part of) a private note back into public collateral
// paid to `recipient`. The rest goes into a change note for the same owner.
//
// Public: root, amount, recipient (a field derived from the recipient's
// address, so a relayer can't redirect the payout).
// Outputs: the spent note's nullifier and the change note's commitment.

include "notes.circom";

template WithdrawNote(LEVELS) {
    signal input root;
    signal input amount;
    signal input recipient;

    signal input noteAmount;
    signal input ownerSecret;
    signal input noteSalt;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];
    signal input changeSalt;

    signal output nullifier;
    signal output changeCommitment;

    component spend = SpendNote(LEVELS);
    spend.root <== root;
    spend.amount <== noteAmount;
    spend.ownerSecret <== ownerSecret;
    spend.salt <== noteSalt;
    for (var i = 0; i < LEVELS; i++) {
        spend.pathElements[i] <== pathElements[i];
        spend.pathIndices[i] <== pathIndices[i];
    }
    nullifier <== spend.nullifier;

    component amountBits = Num2Bits(64);
    amountBits.in <== amount;
    component fits = LessEqThan(64);
    fits.in[0] <== amount;
    fits.in[1] <== noteAmount;
    fits.out === 1;

    component change = NoteCommitment();
    change.amount <== noteAmount - amount;
    change.ownerHash <== spend.ownerHash;
    change.salt <== changeSalt;
    changeCommitment <== change.out;

    // Bind the recipient into the proof's constraints.
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

component main {public [root, amount, recipient]} = WithdrawNote(20);
