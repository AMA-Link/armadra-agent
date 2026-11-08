/**
 * 可注入的超时计时器（#266 / #267）。
 *
 * bash 的自动转后台阈值、后台任务与后台子 Agent 的寿命上限都从这里取计时器：缺省真实 `setTimeout`，
 * 测试注入手动时钟（仓库约定：测试不靠墙钟）。codemode 的沙箱超时另有同形状的注入点（codemode/host-side.ts）。
 */

export interface TimeoutTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** 真实计时器；handle 不阻止进程退出。 */
export const REAL_TIMERS: TimeoutTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 把毫秒数写成给模型看的分钟数（固定英文文案用）。 */
export function minutesOf(ms: number): string {
  const minutes = ms / 60_000;
  return `${Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10} min`;
}
