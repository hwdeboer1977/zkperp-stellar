pragma circom 2.1.9;

// close_position: the owner closes a position (opened by open_position or
// open_private) at the vault's mark price. Soroban counterpart of
// `closePosition` + `settle` in zkperp-midnight.
//
// Proves the position is in the tree and owned (ownerSecret), publishes its
// nullifier, and settles:
//   move    = |exit - entry|,  delta = size * move
//   profit  = min(floor(delta / entry), maxPayout)   (long and price rose, or short and it fell)
//   loss    = ceil(delta / entry)                    (otherwise), at most the collateral
//   closeFee  = ceil(size * feeBps / 10000)
//   borrowFee = ceil(size * borrowRate * (closeTime - openTime) / 10^12)   (step 10)
//   both fees come out of what the loss left; any excess (shortfall)
//   comes out of the profit
//   payout  = equity + profit - shortfall  -> a new private note for the trader
//   fees    = openFee + fees taken         -> a private note for the treasury
//   poolIn  = loss, poolOut = profit - shortfall   (public: the pool's change)
// Fees go to the treasury note, not the pool, so the pool's change is the
// PnL alone (as on Midnight) and a close at an unchanged price shows nothing.
// The fee note's salt is Poseidon(salt, 1), which keepers can compute from
// the keeper note, so the treasury (run with the keeper key) can spend it.
//
// Public inputs: root, exitPrice, closeTime, feeBps, maxPayout, treasuryOwner, borrowRate.
// Outputs: nullifier, payoutCommitment, feeCommitment, poolIn, poolOut.

include "notes.circom";

// out = cond ? a : b, for a boolean cond.
template Select() {
    signal input cond;
    signal input a;
    signal input b;
    signal output out;
    out <== b + cond * (a - b);
}

// min(a, b) for a, b < 2^n.
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

template ClosePosition(LEVELS) {
    // --- public ---
    signal input root;
    signal input exitPrice;
    signal input closeTime;
    signal input feeBps;
    signal input maxPayout;
    signal input treasuryOwner;
    signal input borrowRate;     // per second, scaled by 10^12

    // --- private: the position (as committed at open) ---
    signal input isLong;
    signal input size;
    signal input collateral;     // net of the opening fee
    signal input entryPrice;
    signal input openTime;
    signal input openFee;
    signal input ownerSecret;
    signal input salt;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];
    // --- private: settlement ---
    signal input pnl;            // |PnL|, pinned below
    signal input closeFee;       // pinned below
    signal input borrowFee;      // pinned below
    signal input payoutOwner;    // owner hash of the payout note (the trader's choice)
    signal input payoutSalt;

    // --- outputs ---
    signal output nullifier;
    signal output payoutCommitment;
    signal output feeCommitment;
    signal output poolIn;
    signal output poolOut;

    // Ranges: everything that is compared or subtracted fits 64 bits.
    component r1 = Num2Bits(64); r1.in <== exitPrice;
    component r2 = Num2Bits(64); r2.in <== closeTime;
    component r3 = Num2Bits(64); r3.in <== pnl;
    component r4 = Num2Bits(64); r4.in <== closeFee;
    component r5 = Num2Bits(64); r5.in <== maxPayout;
    component r6 = Num2Bits(14); r6.in <== feeBps;
    component r7 = Num2Bits(64); r7.in <== size;
    component r8 = Num2Bits(64); r8.in <== collateral;
    component r9 = Num2Bits(64); r9.in <== entryPrice;
    component r10 = Num2Bits(64); r10.in <== openTime;
    component r11 = Num2Bits(64); r11.in <== openFee;
    component r12 = Num2Bits(32); r12.in <== borrowRate;
    component r13 = Num2Bits(64); r13.in <== borrowFee;
    isLong * (isLong - 1) === 0;

    // --- the position exists and is the prover's ---
    component owner = Poseidon(1);
    owner.inputs[0] <== ownerSecret;
    component pos = Poseidon(8);
    pos.inputs[0] <== isLong;
    pos.inputs[1] <== size;
    pos.inputs[2] <== collateral;
    pos.inputs[3] <== entryPrice;
    pos.inputs[4] <== openTime;
    pos.inputs[5] <== openFee;
    pos.inputs[6] <== owner.out;
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

    // A close can't be dated before its open.
    component afterOpen = LessEqThan(64);
    afterOpen.in[0] <== openTime;
    afterOpen.in[1] <== closeTime;
    afterOpen.out === 1;

    // --- closing fee: exactly ceil(size * feeBps / 10000) ---
    signal owed;
    owed <== size * feeBps;
    component feeLow = LessEqThan(80);
    feeLow.in[0] <== owed;
    feeLow.in[1] <== closeFee * 10000;
    feeLow.out === 1;
    component feeHigh = LessThan(80);
    feeHigh.in[0] <== closeFee * 10000;
    feeHigh.in[1] <== owed + 10000;
    feeHigh.out === 1;

    // --- borrow fee: exactly ceil(size * borrowRate * held / 10^12) ---
    signal sizeRate;
    sizeRate <== size * borrowRate;
    signal accrued;                          // < 2^160
    accrued <== sizeRate * (closeTime - openTime);
    component borrowLow = LessEqThan(170);
    borrowLow.in[0] <== accrued;
    borrowLow.in[1] <== borrowFee * 1000000000000;
    borrowLow.out === 1;
    component borrowHigh = LessThan(170);
    borrowHigh.in[0] <== borrowFee * 1000000000000;
    borrowHigh.in[1] <== accrued + 1000000000000;
    borrowHigh.out === 1;

    // --- direction of the move and who wins ---
    component rose = LessEqThan(64);        // entry <= exit
    rose.in[0] <== entryPrice;
    rose.in[1] <== exitPrice;
    component fell = LessEqThan(64);        // exit <= entry
    fell.in[0] <== exitPrice;
    fell.in[1] <== entryPrice;
    component win = Select();
    win.cond <== isLong;
    win.a <== rose.out;
    win.b <== fell.out;
    signal isProfit;
    isProfit <== win.out;

    component mv = Select();
    mv.cond <== rose.out;
    mv.a <== exitPrice - entryPrice;
    mv.b <== entryPrice - exitPrice;
    signal delta;                           // size * |exit - entry| < 2^128
    delta <== size * mv.out;
    signal pe;                              // pnl * entry < 2^128
    pe <== pnl * entryPrice;

    // Profit: pnl <= maxPayout, pnl*entry <= delta, and exact unless capped:
    // pnl == maxPayout or (pnl + 1) * entry > delta.
    component capOk = LessEqThan(64);
    capOk.in[0] <== pnl;
    capOk.in[1] <== maxPayout;
    component notOver = LessEqThan(130);
    notOver.in[0] <== pe;
    notOver.in[1] <== delta;
    component capped = IsEqual();
    capped.in[0] <== pnl;
    capped.in[1] <== maxPayout;
    component exactHigh = LessThan(130);
    exactHigh.in[0] <== delta;
    exactHigh.in[1] <== pe + entryPrice;
    signal profitOk;
    profitOk <== capOk.out * notOver.out;
    signal notExact;
    notExact <== (1 - capped.out) * (1 - exactHigh.out);
    isProfit * (1 - profitOk) === 0;
    isProfit * notExact === 0;

    // Loss: exactly ceil(delta / entry): delta <= pnl*entry < delta + entry.
    component lossLow = LessEqThan(130);
    lossLow.in[0] <== delta;
    lossLow.in[1] <== pe;
    component lossHigh = LessThan(130);
    lossHigh.in[0] <== pe;
    lossHigh.in[1] <== delta + entryPrice;
    signal lossOk;
    lossOk <== lossLow.out * lossHigh.out;
    (1 - isProfit) * (1 - lossOk) === 0;

    // --- settlement (amounts chosen without branches) ---
    component lossCap = Min(64);            // a loss takes at most the collateral
    lossCap.a <== pnl;
    lossCap.b <== collateral;
    signal lossAmt;
    lossAmt <== (1 - isProfit) * lossCap.out;
    signal afterLoss;
    afterLoss <== collateral - lossAmt;

    signal fees;
    fees <== closeFee + borrowFee;            // < 2^65
    component feeTaken = Min(66);
    feeTaken.a <== fees;
    feeTaken.b <== afterLoss;
    signal shortfall;
    shortfall <== fees - feeTaken.out;
    signal equity;
    equity <== afterLoss - feeTaken.out;

    signal profitRaw;
    profitRaw <== isProfit * pnl;
    component covers = LessEqThan(66);      // shortfall <= profitRaw
    covers.in[0] <== shortfall;
    covers.in[1] <== profitRaw;
    signal profitAmt;
    profitAmt <== covers.out * (profitRaw - shortfall);

    poolIn <== lossAmt;
    poolOut <== profitAmt;

    // --- outputs: the trader's payout note and the treasury's fee note ---
    component payout = NoteCommitment();
    payout.amount <== equity + profitAmt;
    payout.ownerHash <== payoutOwner;
    payout.salt <== payoutSalt;
    payoutCommitment <== payout.out;

    component feeSalt = Poseidon(2);
    feeSalt.inputs[0] <== salt;
    feeSalt.inputs[1] <== 1;
    component fee = NoteCommitment();
    fee.amount <== openFee + feeTaken.out;
    fee.ownerHash <== treasuryOwner;
    fee.salt <== feeSalt.out;
    feeCommitment <== fee.out;
}

component main {public [root, exitPrice, closeTime, feeBps, maxPayout, treasuryOwner, borrowRate]} = ClosePosition(20);
