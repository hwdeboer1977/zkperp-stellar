pragma circom 2.1.9;

// cancel_limit: the owner cancels an unfilled limit order (step 13; Midnight's
// cancelLimitOrder) and gets the escrowed collateral back as a note (salt
// Poseidon(orderSalt, 5)). Proves the order's owner hash is Poseidon(ownerSecret).
// Public input: order. Output: the refund note's commitment.

include "limit.circom";

template CancelLimit() {
    signal input order;
    signal input isLong;
    signal input size;
    signal input collateral;
    signal input limitPrice;
    signal input ownerSecret;
    signal input orderSalt;
    signal output refund;

    component owner = Poseidon(1);
    owner.inputs[0] <== ownerSecret;
    component o = LimitCommitment();
    o.isLong <== isLong;
    o.size <== size;
    o.collateral <== collateral;
    o.limitPrice <== limitPrice;
    o.ownerHash <== owner.out;
    o.orderSalt <== orderSalt;
    o.out === order;

    component s = Poseidon(2);
    s.inputs[0] <== orderSalt;
    s.inputs[1] <== 5;
    component n = NoteCommitment();
    n.amount <== collateral;
    n.ownerHash <== owner.out;
    n.salt <== s.out;
    refund <== n.out;
}

component main {public [order]} = CancelLimit();
