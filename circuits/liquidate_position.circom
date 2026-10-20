pragma circom 2.1.9;

// liquidate_position: a keeper closes a position whose equity fell below the
// maintenance margin. Soroban counterpart of `liquidatePosition` in
// zkperp-midnight (maintenance 250 bps, liquidation fee 50 bps there).
//
// The keeper knows every field from the keeper note (direction, size,
// collateral, entry, open time, open fee, owner hash, salt) but not the owner
// secret, so the position is identified by its owner HASH. Settles like a
// close (close_position.circom), with three differences:
//   - only a loss or a flat position: a profit can't be liquidated (pnl = 0)
//   - equity * 10000 < size * maintenanceBps (below maintenance), checked
//   - a liquidation fee ceil(size * liqFeeBps / 10000), out of the equity
//   - (step 10) a borrow fee ceil(size * borrowRate * held / 10^12), with the
//     closing fee, before equity is measured
// What equity is left goes to a note for the position's OWNER (owner hash from
// the commitment, salt Poseidon(salt, 2)), which the owner can find and spend.
// The fees (open + close + liquidation) go to the treasury note (salt
// Poseidon(salt, 1)); keepers are paid from the treasury, because a public
// keeper fee would reveal the size.
//
// Public inputs: root, exitPrice, liqTime, feeBps, treasuryOwner,
//                maintenanceBps, liqFeeBps, borrowRate.
// Outputs: nullifier, payoutCommitment, feeCommitment, poolIn.

include "notes.circom";

template Select() {
    signal input cond;
    signal input a;
    signal input b;
    signal output out;
    out <== b + cond * (a - b);
}

template Min(n) {
    signal input a;
    signal input b;
    signal output out;
    component lt = LessThan(n);
    lt.in[0] <== a;
    lt.in[1] <== b;
    component s = Select();
    s.cond <== lt.out;
    s.a <== a;
    s.b <== b;
    out <== s.out;
}

// ceil(size * bps / 10000) == fee, exactly.
template CeilFee() {
    signal input size;
    signal input bps;
    signal input fee;
    signal owed;
    owed <== size * bps;
    component low = LessEqThan(80);
    low.in[0] <== owed;
    low.in[1] <== fee * 10000;
    low.out === 1;
    component high = LessThan(80);
    high.in[0] <== fee * 10000;
    high.in[1] <== owed + 10000;
    high.out === 1;
}

template LiquidatePosition(LEVELS) {
    // --- public ---
    signal input root;
    signal input exitPrice;
    signal input liqTime;
    signal input feeBps;
    signal input treasuryOwner;
    signal input maintenanceBps;
    signal input liqFeeBps;
    signal input borrowRate;

    // --- private: the position, as the keeper note gives it ---
    signal input isLong;
    signal input size;
    signal input collateral;
    signal input entryPrice;
    signal input openTime;
    signal input openFee;
    signal input ownerHash;
    signal input salt;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];
    // --- private: settlement ---
    signal input pnl;            // the loss (0 if flat)
    signal input closeFee;
    signal input liqFee;
    signal input borrowFee;

    // --- outputs ---
    signal output nullifier;
    signal output payoutCommitment;
    signal output feeCommitment;
    signal output poolIn;

    component r1 = Num2Bits(64); r1.in <== exitPrice;
    component r2 = Num2Bits(64); r2.in <== liqTime;
    component r3 = Num2Bits(64); r3.in <== pnl;
    component r4 = Num2Bits(64); r4.in <== closeFee;
    component r5 = Num2Bits(64); r5.in <== liqFee;
    component r6 = Num2Bits(14); r6.in <== feeBps;
    component r7 = Num2Bits(14); r7.in <== maintenanceBps;
    component r8 = Num2Bits(14); r8.in <== liqFeeBps;
    component r9 = Num2Bits(64); r9.in <== size;
    component r10 = Num2Bits(64); r10.in <== collateral;
    component r11 = Num2Bits(64); r11.in <== entryPrice;
    component r12 = Num2Bits(64); r12.in <== openTime;
    component r13 = Num2Bits(64); r13.in <== openFee;
    component r14 = Num2Bits(32); r14.in <== borrowRate;
    component r15 = Num2Bits(64); r15.in <== borrowFee;
    isLong * (isLong - 1) === 0;

    // --- the position exists (identified by owner hash, not owner secret) ---
    component pos = Poseidon(8);
    pos.inputs[0] <== isLong;
    pos.inputs[1] <== size;
    pos.inputs[2] <== collateral;
    pos.inputs[3] <== entryPrice;
    pos.inputs[4] <== openTime;
    pos.inputs[5] <== openFee;
    pos.inputs[6] <== ownerHash;
    pos.inputs[7] <== salt;
    component tree = MerkleRoot(LEVELS);
    tree.leaf <== pos.out;
    for (var i = 0; i < LEVELS; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;
    component n = Poseidon(2);
    n.inputs[0] <== salt;
    n.inputs[1] <== tree.index;
    nullifier <== n.out;

    component afterOpen = LessEqThan(64);
    afterOpen.in[0] <== openTime;
    afterOpen.in[1] <== liqTime;
    afterOpen.out === 1;

    component cf = CeilFee();
    cf.size <== size;
    cf.bps <== feeBps;
    cf.fee <== closeFee;
    component lf = CeilFee();
    lf.size <== size;
    lf.bps <== liqFeeBps;
    lf.fee <== liqFee;

    signal sizeRate;
    sizeRate <== size * borrowRate;
    signal accrued;
    accrued <== sizeRate * (liqTime - openTime);
    component borrowLow = LessEqThan(170);
    borrowLow.in[0] <== accrued;
    borrowLow.in[1] <== borrowFee * 1000000000000;
    borrowLow.out === 1;
    component borrowHigh = LessThan(170);
    borrowHigh.in[0] <== borrowFee * 1000000000000;
    borrowHigh.in[1] <== accrued + 1000000000000;
    borrowHigh.out === 1;

    // --- the move: only a loss or flat may be liquidated ---
    component rose = LessEqThan(64);
    rose.in[0] <== entryPrice;
    rose.in[1] <== exitPrice;
    component fell = LessEqThan(64);
    fell.in[0] <== exitPrice;
    fell.in[1] <== entryPrice;
    component win = Select();
    win.cond <== isLong;
    win.a <== rose.out;
    win.b <== fell.out;
    signal isProfit;
    isProfit <== win.out;
    isProfit * pnl === 0;                  // a position in profit can't be liquidated

    component mv = Select();
    mv.cond <== rose.out;
    mv.a <== exitPrice - entryPrice;
    mv.b <== entryPrice - exitPrice;
    signal delta;
    delta <== size * mv.out;
    signal pe;
    pe <== pnl * entryPrice;
    // Loss is exactly ceil(delta / entry) (when not a "profit"; flat is both).
    component lossLow = LessEqThan(130);
    lossLow.in[0] <== delta;
    lossLow.in[1] <== pe;
    component lossHigh = LessThan(130);
    lossHigh.in[0] <== pe;
    lossHigh.in[1] <== delta + entryPrice;
    signal lossOk;
    lossOk <== lossLow.out * lossHigh.out;
    (1 - isProfit) * (1 - lossOk) === 0;

    // --- settlement ---
    component lossCap = Min(64);
    lossCap.a <== pnl;
    lossCap.b <== collateral;
    signal lossAmt;
    lossAmt <== (1 - isProfit) * lossCap.out;
    signal afterLoss;
    afterLoss <== collateral - lossAmt;
    component feeTaken = Min(66);
    feeTaken.a <== closeFee + borrowFee;
    feeTaken.b <== afterLoss;
    signal equity;
    equity <== afterLoss - feeTaken.out;

    // Below maintenance: equity * 10000 < size * maintenanceBps.
    component below = LessThan(80);
    below.in[0] <== equity * 10000;
    below.in[1] <== size * maintenanceBps;
    below.out === 1;

    component liqTaken = Min(64);
    liqTaken.a <== liqFee;
    liqTaken.b <== equity;
    signal back;
    back <== equity - liqTaken.out;

    poolIn <== lossAmt;

    // What is left, to the owner: salt Poseidon(salt, 2), which the owner knows.
    component paySalt = Poseidon(2);
    paySalt.inputs[0] <== salt;
    paySalt.inputs[1] <== 2;
    component payout = NoteCommitment();
    payout.amount <== back;
    payout.ownerHash <== ownerHash;
    payout.salt <== paySalt.out;
    payoutCommitment <== payout.out;

    // All fees to the treasury: salt Poseidon(salt, 1), as for a close.
    component feeSalt = Poseidon(2);
    feeSalt.inputs[0] <== salt;
    feeSalt.inputs[1] <== 1;
    component fee = NoteCommitment();
    fee.amount <== openFee + feeTaken.out + liqTaken.out;
    fee.ownerHash <== treasuryOwner;
    fee.salt <== feeSalt.out;
    feeCommitment <== fee.out;
}

component main {public [root, exitPrice, liqTime, feeBps, treasuryOwner, maintenanceBps, liqFeeBps, borrowRate]} = LiquidatePosition(20);
