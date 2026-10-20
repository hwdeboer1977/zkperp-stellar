pragma circom 2.1.9;

// Verifiable encryption to the keepers' view key (BabyJubJub ECDH), shared
// by the order circuits (steps 11-13). Same scheme as the keeper note in
// open_position.circom:  R = e*Base8, S = e*keeperPk, note[i] = field[i] + Poseidon(S.x, i).

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/babyjub.circom";
include "node_modules/circomlib/circuits/escalarmulany.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

template SealToKeepers(N) {
    signal input fields[N];
    signal input keeperPk[2];
    signal input ephemeral;
    signal output R[2];
    signal output note[N];

    component eZero = IsZero();
    eZero.in <== ephemeral;
    eZero.out === 0;
    component r = BabyPbk();
    r.in <== ephemeral;
    R[0] <== r.Ax;
    R[1] <== r.Ay;
    component eBits = Num2Bits(253);
    eBits.in <== ephemeral;
    component shared = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) {
        shared.e[i] <== eBits.out[i];
    }
    shared.p[0] <== keeperPk[0];
    shared.p[1] <== keeperPk[1];
    component pad[N];
    for (var i = 0; i < N; i++) {
        pad[i] = Poseidon(2);
        pad[i].inputs[0] <== shared.out[0];
        pad[i].inputs[1] <== i;
        note[i] <== fields[i] + pad[i].out;
    }
}
