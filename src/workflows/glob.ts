/** [#318] contract.owns 的 glob 方言（§5.7）。[M1 桩，M5 实现] */
import { AmaError } from "../errors.js";

/** 返回非法原因；合法返回 undefined。 */
export function validateOwnsGlob(_glob: string): string | undefined {
  throw new AmaError("not_implemented", "validateOwnsGlob is not implemented yet");
}

export function globsOverlap(_a: string, _b: string): boolean {
  throw new AmaError("not_implemented", "globsOverlap is not implemented yet");
}
