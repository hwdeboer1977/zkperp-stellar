pragma circom 2.1.9;

// open_private: opens a long or short with collateral taken from a private
// note, so neither the collateral amount nor the trader is public.
// Same position rules as open_position.circom (fee, 1x-20x leverage,
// commitment, verifiable keeper note); the difference is where the
// collateral comes from:
//   - a note in the tree under `root` (membership + ownership + nullifier)
//   - collateral <= note amount; the rest becomes a change note
// The position is owned by the same owner as the note.
//
// Public inputs: root, entryPrice, openTime, feeBps, keeperPk.
// Outputs: nullifier, position commitment, change commitment, keeper note.

include "notes.circom";
include "node_modules/circomlib/circuits/babyjub.circom";
include "node_modules/circomlib/circuits/escalarmulany.circom";

template OpenPrivate(LEVELS, MAX_LEVERAGE) {
    // --- public ---
    signal input root;
    signal input entryPrice;
    signal input openTime;
    signal input feeBps;
    signal input keeperPk[2];

    // --- private: the note being spent ---
    signal input noteAmount;
    signal input ownerSecret;
    signal input noteSalt;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];
    // --- private: the position and the change ---
    signal input isLong;
    signal input size;
    signal input collateral;    // gross, taken from the note
    signal input openFee;
    signal input salt;          // position secret
    signal input ephemeral;
    signal input changeSalt;

    // --- outputs ---
    signal output nullifier;
    signal output commitment;
    signal output changeCommitment;
    signal output noteR[2];
    signal output note[8];

    // Spend the note.
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

    // Collateral comes out of the note; the rest is change.
    component collBits = Num2Bits(64);    collBits.in <== collateral;
    component fits = LessEqThan(64);
    fits.in[0] <== collateral;
    fits.in[1] <== noteAmount;
    fits.out === 1;
    component change = NoteCommitment();
    change.amount <== noteAmount - collateral;
    change.ownerHash <== spend.ownerHash;
    change.salt <== changeSalt;
    changeCommitment <== change.out;

    // --- position rules (as open_position.circom) ---
    isLong * (isLong - 1) === 0;
    component sizeBits = Num2Bits(64);    sizeBits.in <== size;
    component feeBits = Num2Bits(64);     feeBits.in <== openFee;
    component priceBits = Num2Bits(64);   priceBits.in <== entryPrice;
    component timeBits = Num2Bits(64);    timeBits.in <== openTime;
    component rateBits = Num2Bits(14);    rateBits.in <== feeBps;

    signal owed;
    owed <== size * feeBps;
    component feeLow = LessEqThan(80);
    feeLow.in[0] <== owed;
    feeLow.in[1] <== openFee * 10000;
    feeLow.out === 1;
    component feeHigh = LessThan(80);
    feeHigh.in[0] <== openFee * 10000;
    feeHigh.in[1] <== owed + 10000;
    feeHigh.out === 1;

    component feeFits = LessThan(64);
    feeFits.in[0] <== openFee;
    feeFits.in[1] <== collateral;
    feeFits.out === 1;
    signal net;
    net <== collateral - openFee;

    component levLow = LessEqThan(64);
    levLow.in[0] <== net;
    levLow.in[1] <== size;
    levLow.out === 1;
    component levHigh = LessEqThan(72);
    levHigh.in[0] <== size;
    levHigh.in[1] <== net * MAX_LEVERAGE;
    levHigh.out === 1;

    signal fields[8];
    fields[0] <== isLong;
    fields[1] <== size;
    fields[2] <== net;
    fields[3] <== entryPrice;
    fields[4] <== openTime;
    fields[5] <== openFee;
    fields[6] <== spend.ownerHash;
    fields[7] <== salt;

    component h = Poseidon(8);
    for (var i = 0; i < 8; i++) {
        h.inputs[i] <== fields[i];
    }
    commitment <== h.out;

    component eZero = IsZero();
    eZero.in <== ephemeral;
    eZero.out === 0;
    component r = BabyPbk();
    r.in <== ephemeral;
    noteR[0] <== r.Ax;
    noteR[1] <== r.Ay;

    component eBits = Num2Bits(253);
    eBits.in <== ephemeral;
    component shared = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) {
        shared.e[i] <== eBits.out[i];
    }
    shared.p[0] <== keeperPk[0];
    shared.p[1] <== keeperPk[1];

    component pad[8];
    for (var i = 0; i < 8; i++) {
        pad[i] = Poseidon(2);
        pad[i].inputs[0] <== shared.out[0];
        pad[i].inputs[1] <== i;
        note[i] <== fields[i] + pad[i].out;
    }
}

component main {public [root, entryPrice, openTime, feeBps, keeperPk]} = OpenPrivate(20, 20);
