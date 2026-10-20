pragma circom 2.1.9;

// Shared parts of limit orders (step 13).
//   order commitment = Poseidon(isLong, size, collateral, limit, ownerHash, orderSalt)
// `collateral` is gross (the fee is taken at fill). A filled order's position
// has salt Poseidon(orderSalt, 4); a cancelled order's refund note has salt
// Poseidon(orderSalt, 5).

include "notes.circom";

template LimitCommitment() {
    signal input isLong;
    signal input size;
    signal input collateral;
    signal input limitPrice;
    signal input ownerHash;
    signal input orderSalt;
    signal output out;
    component h = Poseidon(6);
    h.inputs[0] <== isLong;
    h.inputs[1] <== size;
    h.inputs[2] <== collateral;
    h.inputs[3] <== limitPrice;
    h.inputs[4] <== ownerHash;
    h.inputs[5] <== orderSalt;
    out <== h.out;
}
