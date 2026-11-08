/**
 * 手动计时器（#266 / #267 的测试）：记录 `set` 的延迟，由测试决定何时触发，不靠墙钟。
 */

import type { TimeoutTimers } from "../../src/tools/timers.js";

export interface ManualTimers extends TimeoutTimers {
  /** 仍在等的计时器（按登记顺序）。 */
  pending(): { ms: number }[];
  /** 触发第 `index` 个仍在等的计时器（缺省最早的一个）；没有则抛错。 */
  fire(index?: number): void;
  /** 触发全部仍在等的计时器。 */
  fireAll(): void;
  /** 历次 `set` 的延迟（含已触发、已清除）。 */
  readonly delays: number[];
}

export function manualTimers(): ManualTimers {
  let seq = 0;
  const waiting = new Map<number, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  return {
    delays,
    set(fn, ms) {
      const id = ++seq;
      waiting.set(id, { fn, ms });
      delays.push(ms);
      return id;
    },
    clear(handle) {
      waiting.delete(handle as number);
    },
    pending() {
      return [...waiting.values()].map(({ ms }) => ({ ms }));
    },
    fire(index = 0) {
      const entry = [...waiting.entries()][index];
      if (entry === undefined) throw new Error("no pending timer to fire");
      waiting.delete(entry[0]);
      entry[1].fn();
    },
    fireAll() {
      for (const [id, { fn }] of [...waiting.entries()]) {
        waiting.delete(id);
        fn();
      }
    },
  };
}
