pragma circom 2.1.9;

// execute_limit: a keeper fills a limit order (step 13; Midnight's
// executeLimitOrder): once the mark price reached the limit (long: mark <=
// limit; short: mark >= limit), opens the position AT THE MARK PRICE with the
// escrowed collateral, under the same rules as an open (fee exact, net
// collateral > 0, leverage 1x-20x). The position's salt is
// Poseidon(orderSalt, 4), so the owner and every keeper can rebuild it from
// the order and the fill (no new keeper note needed).
// Public inputs: order, entryPrice (mark), openTime, feeBps. Output: the
// position commitment.

include "limit.circom";

template ExecuteLimit(MAX_LEVERAGE) {
    signal input order;
    signal input entryPrice;
    signal input openTime;
    signal input feeBps;

    signal input isLong;
    signal input size;
    signal input collateral;
    signal input limitPrice;
    signal input ownerHash;
    signal input orderSalt;
    signal input openFee;

    signal output commitment;

    component o = LimitCommitment();
    o.isLong <== isLong;
    o.size <== size;
    o.collateral <== collateral;
    o.limitPrice <== limitPrice;
    o.ownerHash <== ownerHash;
    o.orderSalt <== orderSalt;
    o.out === order;

    isLong * (isLong - 1) === 0;
    component r1 = Num2Bits(64); r1.in <== size;
    component r2 = Num2Bits(64); r2.in <== collateral;
    component r3 = Num2Bits(64); r3.in <== openFee;
    component r4 = Num2Bits(64); r4.in <== entryPrice;
    component r5 = Num2Bits(64); r5.in <== openTime;
    component r6 = Num2Bits(14); r6.in <== feeBps;
    component r7 = Num2Bits(64); r7.in <== limitPrice;

    // Limit reached: long at mark <= limit, short at mark >= limit.
    component le = LessEqThan(64);
    le.in[0] <== entryPrice;
    le.in[1] <== limitPrice;
    component ge = LessEqThan(64);
    ge.in[0] <== limitPrice;
    ge.in[1] <== entryPrice;
    signal longOk;
    longOk <== isLong * le.out;
    signal shortOk;
    shortOk <== (1 - isLong) * ge.out;
    longOk + shortOk === 1;

    // The open rules (as open_position.circom).
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

    component posSalt = Poseidon(2);
    posSalt.inputs[0] <== orderSalt;
    posSalt.inputs[1] <== 4;
    component pos = Poseidon(8);
    pos.inputs[0] <== isLong;
    pos.inputs[1] <== size;
    pos.inputs[2] <== net;
    pos.inputs[3] <== entryPrice;
    pos.inputs[4] <== openTime;
    pos.inputs[5] <== openFee;
    pos.inputs[6] <== ownerHash;
    pos.inputs[7] <== posSalt.out;
    commitment <== pos.out;
}

component main {public [order, entryPrice, openTime, feeBps]} = ExecuteLimit(20);
