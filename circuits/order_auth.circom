pragma circom 2.1.9;

// order_auth: the owner of a position places (action 1) or cancels (action 2)
// a trigger order on it: stop loss (kind 0) or take profit (kind 1) at
// `trigger`. Steps 11-12; Midnight's placeOrder / cancelOrder.
//
// Proves the position is in the tree and owned (ownerSecret), and outputs
//   orderId = Poseidon(position salt, kind, trigger, orderSalt)
// plus an order note for the keepers: [leafIndex, kind, trigger, orderSalt],
// verifiably encrypted, so a keeper can find the position and the level.
// Public: neither the position, nor the kind, nor the level; only orderId.
// `action` is a public input, so a placement proof can't be replayed as a
// cancellation (or the other way round).

include "notes.circom";
include "seal.circom";

template OrderAuth(LEVELS) {
    signal input root;
    signal input action;         // 1 place, 2 cancel
    signal input keeperPk[2];

    signal input isLong;
    signal input size;
    signal input collateral;
    signal input entryPrice;
    signal input openTime;
    signal input openFee;
    signal input ownerSecret;
    signal input salt;
    signal input pathElements[LEVELS];
    signal input pathIndices[LEVELS];
    signal input kind;           // 0 stop loss, 1 take profit
    signal input trigger;
    signal input orderSalt;
    signal input ephemeral;

    signal output orderId;
    signal output noteR[2];
    signal output note[4];

    (action - 1) * (action - 2) === 0;
    kind * (kind - 1) === 0;
    component tb = Num2Bits(64); tb.in <== trigger;

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

    component id = Poseidon(4);
    id.inputs[0] <== salt;
    id.inputs[1] <== kind;
    id.inputs[2] <== trigger;
    id.inputs[3] <== orderSalt;
    orderId <== id.out;

    component seal = SealToKeepers(4);
    seal.fields[0] <== tree.index;
    seal.fields[1] <== kind;
    seal.fields[2] <== trigger;
    seal.fields[3] <== orderSalt;
    seal.keeperPk[0] <== keeperPk[0];
    seal.keeperPk[1] <== keeperPk[1];
    seal.ephemeral <== ephemeral;
    noteR[0] <== seal.R[0];
    noteR[1] <== seal.R[1];
    for (var i = 0; i < 4; i++) {
        note[i] <== seal.note[i];
    }
}

component main {public [root, action, keeperPk]} = OrderAuth(20);
