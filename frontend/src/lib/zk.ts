// The ZK code shared with the CLI and services (circuits/lib), in the
// browser. Proving files are served from /zk/ (synced by scripts/sync.mjs).
// The modules are plain JavaScript, tested in circuits/test; typed loosely here.
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as Record<string, unknown>).ZKPERP_KEYS_URL = "/zk/";
import * as tree from "@zk/tree.mjs";
import * as notes from "@zk/notes.mjs";
import * as priv from "@zk/private.mjs";
import * as close from "@zk/close.mjs";
import * as liq from "@zk/liquidate.mjs";
import * as orders from "@zk/orders.mjs";
import * as limits from "@zk/limits.mjs";

const Z: any = { ...tree, ...notes, ...priv, ...close, ...liq, ...orders, ...limits };
export const Tree: any = Z.Tree;
export const { newNote, ownerHashOf, nullifierOf, recipientField, noteInner, noteCommitment, proveOpenPrivate, proveWithdraw, proveMerge,
  proveClose, settle, borrowFeeOf, settleLiquidation, liquidationPayoutNote, proveOrderAuth, orderIdOf, orderPayoutNote, KIND, newOrderSalt,
  fires, provePlaceLimit, proveCancelLimit, filledPosition, reached }: Record<string, any> = Z;
