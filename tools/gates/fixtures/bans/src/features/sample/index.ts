import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const sample = Effect.runPromise(Effect.as(Effect.void, FileSystem.FileSystem));
