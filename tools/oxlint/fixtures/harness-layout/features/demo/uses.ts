export { tool } from "../../tools/demo/index.ts";
export { tool as again } from "./good.scenario.ts";

export const late = await import("./good.scenario.ts");
