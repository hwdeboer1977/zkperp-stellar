// Creates the keepers' shared BabyJubJub view key and writes it to .env
// (KEEPER_VIEW_SK secret, KEEPER_VIEW_PK_X/Y public), then prints the public
// half for init_perp. Refuses to overwrite: positions encrypted to the old
// key would become unreadable.
import { newKeeperKey } from "../lib/keeper.mjs";
import { cfg, setEnv } from "../lib/stellar.mjs";

if (cfg("KEEPER_VIEW_SK")) {
  console.error("KEEPER_VIEW_SK is already set in .env; not overwriting");
  process.exit(1);
}
const key = await newKeeperKey();
setEnv({ KEEPER_VIEW_SK: key.sk, KEEPER_VIEW_PK_X: key.pk[0], KEEPER_VIEW_PK_Y: key.pk[1] });
console.log(JSON.stringify({ x: key.pk[0], y: key.pk[1] }));
process.exit(0);
