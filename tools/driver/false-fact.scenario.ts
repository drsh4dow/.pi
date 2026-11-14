/** A false claim fails the run: it prints the claim and exits 1. Run it to see the driver's failure path. */
import { scenario } from "./index.ts";

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) => run.check(run.pi.version === "0.0.0", `pi runs version 0.0.0 (it runs ${run.pi.version})`),
});
