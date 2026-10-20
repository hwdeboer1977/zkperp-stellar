pragma circom 2.1.9;

// place_limit: escrows collateral from a private note into a limit order
// (step 13; Midnight's placeLimitOrder). Spends the note, outputs the order
// commitment and a change note, and a note for the keepers with the order's
// fields [isLong, size, collateral, limit, ownerHash, orderSalt] (verifiably
// encrypted). Public: root, keeperPk. Nothing about the order is public.

include "limit.circom";
include "seal.circom";

template PlaceLimit(LEVELS) {
    signal input root;
    signal input keeperPk[2];

    signal input noteAmount;
    signal input ownerSecret;
    signal input noteSalt;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];
    signal input changeSalt;
    signal input isLong;
    signal input size;
    signal input collateral;
    signal input limitPrice;
    signal input orderSalt;
    signal input ephemeral;

    signal output nullifier;
    signal output order;
    signal output changeCommitment;
    signal output noteR[2];
    signal output note[6];

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

    isLong * (isLong - 1) === 0;
    component cb = Num2Bits(64); cb.in <== collateral;
    component sb = Num2Bits(64); sb.in <== size;
    component lb = Num2Bits(64); lb.in <== limitPrice;
    component fits = LessEqThan(64);
    fits.in[0] <== collateral;
    fits.in[1] <== noteAmount;
    fits.out === 1;

    component change = NoteCommitment();
    change.amount <== noteAmount - collateral;
    change.ownerHash <== spend.ownerHash;
    change.salt <== changeSalt;
    changeCommitment <== change.out;

    component o = LimitCommitment();
    o.isLong <== isLong;
    o.size <== size;
    o.collateral <== collateral;
    o.limitPrice <== limitPrice;
    o.ownerHash <== spend.ownerHash;
    o.orderSalt <== orderSalt;
    order <== o.out;

    component seal = SealToKeepers(6);
    seal.fields[0] <== isLong;
    seal.fields[1] <== size;
    seal.fields[2] <== collateral;
    seal.fields[3] <== limitPrice;
    seal.fields[4] <== spend.ownerHash;
    seal.fields[5] <== orderSalt;
    seal.keeperPk[0] <== keeperPk[0];
    seal.keeperPk[1] <== keeperPk[1];
    seal.ephemeral <== ephemeral;
    noteR[0] <== seal.R[0];
    noteR[1] <== seal.R[1];
    for (var i = 0; i < 6; i++) {
        note[i] <== seal.note[i];
    }
}

component main {public [root, keeperPk]} = PlaceLimit(20);
