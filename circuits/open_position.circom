pragma circom 2.1.9;

// open_position: a trader opens a long or short against the ZKPerp vault.
// Soroban counterpart of `openPosition` + `sizing` in zkperp-midnight.
//
// Public (checked by the vault): the gross collateral the trader transfers,
// the mark price and open time, the fee rate, and the keeper view key.
// Private: direction, size, fee, owner and salt. Longs and shorts prove the
// same circuit, so an open does not reveal its direction.
//
// Outputs (also public): the position commitment, which the vault adds to its
// Merkle tree, and a note encrypted to the keepers' view key (BabyJubJub
// ECDH), which lets any keeper read the position and liquidate it. The
// circuit proves the note decrypts to exactly the committed position, so a
// trader cannot make a position unreadable to keepers.

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/babyjub.circom";
include "node_modules/circomlib/circuits/escalarmulany.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// Fields in the commitment and the keeper note, in this order.
//   0 isLong  1 size  2 collateral (net of fee)  3 entryPrice  4 openTime
//   5 openFee 6 ownerHash  7 salt
template OpenPosition(MAX_LEVERAGE) {
    // --- public inputs ---
    signal input collateral;    // gross collateral transferred, token units
    signal input entryPrice;    // vault's mark price
    signal input openTime;      // unix seconds, checked against the ledger
    signal input feeBps;        // opening fee rate, basis points of size
    signal input keeperPk[2];   // keepers' BabyJubJub view key

    // --- private inputs ---
    signal input isLong;        // 1 long, 0 short
    signal input size;          // notional, token units
    signal input openFee;       // ceil(size * feeBps / 10000)
    signal input ownerHash;     // Poseidon(ownerSecret): proves ownership at close
    signal input salt;          // random; also the position secret (nullifier)
    signal input ephemeral;     // random nonzero scalar for this note

    // --- outputs ---
    signal output commitment;
    signal output noteR[2];     // ephemeral * Base8
    signal output note[8];      // field i + Poseidon(sharedX, i)

    // Booleans and ranges, so nothing below can wrap around the field.
    isLong * (isLong - 1) === 0;
    component sizeBits = Num2Bits(64);       sizeBits.in <== size;
    component collBits = Num2Bits(64);       collBits.in <== collateral;
    component feeBits = Num2Bits(64);        feeBits.in <== openFee;
    component priceBits = Num2Bits(64);      priceBits.in <== entryPrice;
    component timeBits = Num2Bits(64);       timeBits.in <== openTime;
    component rateBits = Num2Bits(14);       rateBits.in <== feeBps;

    // Fee is exactly ceil(size * feeBps / 10000):
    //   openFee * 10000 >= size * feeBps  and  openFee * 10000 < size * feeBps + 10000
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

    // The fee must leave some collateral.
    component feeFits = LessThan(64);
    feeFits.in[0] <== openFee;
    feeFits.in[1] <== collateral;
    feeFits.out === 1;
    signal net;
    net <== collateral - openFee;

    // Leverage between 1x and MAX_LEVERAGE x the net collateral.
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
    fields[6] <== ownerHash;
    fields[7] <== salt;

    component h = Poseidon(8);
    for (var i = 0; i < 8; i++) {
        h.inputs[i] <== fields[i];
    }
    commitment <== h.out;

    // Keeper note: R = e * Base8, shared = e * keeperPk.
    // A keeper with sk (keeperPk = sk * Base8) recovers shared = sk * R.
    component eZero = IsZero();
    eZero.in <== ephemeral;
    eZero.out === 0;
    component r = BabyPbk();               // also range-checks e < 2^253
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

component main {public [collateral, entryPrice, openTime, feeBps, keeperPk]} = OpenPosition(20);
