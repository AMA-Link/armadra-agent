import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLocale, setLocale } from "../i18n/index.js";
import type { ToolRegistryApi } from "../tools/types.js";
import { AgentEventBus, createHostApi } from "./api-impl.js";
import { HostResourceRegistry } from "./resources.js";
import { HOST_API_MINOR } from "./types.js";
import { MAX_HOST_RESOURCES, type HostResource } from "../tools/resource-ref.js";

const ok = (scheme: string, describe = `Items of ${scheme}`): HostResource => ({
  scheme,
  describe,
  read: () => ({ text: "" }),
});

// 断言英文文案：测试 setup 钉的是 zh，这里临时切英文
let previous = getLocale();
beforeAll(() => {
  previous = getLocale();
  setLocale("en");
});
afterAll(() => setLocale(previous));

/** 最小工具注册表桩（资源面不碰工具）。 */
function stubRegistry(): ToolRegistryApi {
  return {
    register: () => undefined,
    disable: () => undefined,
    get: () => undefined,
    list: () => [],
    active: () => [],
    setActive: () => undefined,
  };
}

describe("HostResourceRegistry（#270）", () => {
  it("注册、按名排序列出、查找", () => {
    const registry = new HostResourceRegistry();
    registry.register(ok("notes"));
    registry.register(ok("demo"));
    expect(registry.schemes()).toEqual(["demo", "notes"]);
    expect(registry.list()).toEqual([
      { scheme: "demo", describe: "Items of demo" },
      { scheme: "notes", describe: "Items of notes" },
    ]);
    expect(registry.get("demo")?.scheme).toBe("demo");
    expect(registry.get("other")).toBeUndefined();
  });

  it("校验：scheme 形状、保留字、describe、read、同名、数量", () => {
    const registry = new HostResourceRegistry();
    const reject = (resource: unknown, code: string, part: string) => {
      expect(() => registry.register(resource as HostResource)).toThrowError(
        expect.objectContaining({ code, message: expect.stringContaining(part) }),
      );
    };
    reject(null, "invalid_arguments", "must be an object");
    reject(ok("A"), "invalid_arguments", "invalid scheme A");
    reject(ok("c"), "invalid_arguments", "invalid scheme c");
    reject(ok("Demo"), "invalid_arguments", "invalid scheme Demo");
    reject(ok("x".repeat(33)), "invalid_arguments", "invalid scheme");
    for (const scheme of ["http", "https", "file"]) {
      reject(ok(scheme), "invalid_arguments", `scheme ${scheme} is reserved`);
    }
    reject(ok("demo", "two\nlines"), "invalid_arguments", "single-line describe");
    reject(ok("demo", "x".repeat(121)), "invalid_arguments", "at most 120 characters");
    reject({ scheme: "demo", describe: "d" }, "invalid_arguments", "missing read()");
    registry.register(ok("demo"));
    reject(ok("demo"), "tool_exists", "already exists");
    for (let i = 1; i < MAX_HOST_RESOURCES; i++) registry.register(ok(`s${i}`));
    reject(ok("overflow"), "invalid_arguments", `at most ${MAX_HOST_RESOURCES}`);
  });

  it("冻结后不再接受注册", () => {
    const registry = new HostResourceRegistry();
    registry.register(ok("demo"));
    registry.freeze();
    expect(registry.isFrozen).toBe(true);
    expect(() => registry.register(ok("late"))).toThrowError(/fixed once the session starts/);
    expect(registry.schemes()).toEqual(["demo"]);
  });
});

describe("HostApi.resources（host-api 1.2）", () => {
  it("api.resources.register 写进注入的注册表；list 按名排序；minor ≥ 2", () => {
    const resources = new HostResourceRegistry();
    const binding = createHostApi({
      mode: "print",
      session: {
        id: () => "s1",
        file: () => undefined,
        cwd: () => "/w",
        model: () => undefined,
      },
      tools: stubRegistry(),
      bus: new AgentEventBus(),
      sendUser: async () => "queued",
      stderr: () => undefined,
      resources,
    });
    expect(binding.api.minor).toBe(HOST_API_MINOR);
    expect(HOST_API_MINOR).toBeGreaterThanOrEqual(2); // resources 自 1.2 起
    expect(binding.api.resources).toBeDefined();
    binding.api.resources?.register(ok("notes"));
    binding.api.resources?.register(ok("demo"));
    expect(binding.api.resources?.list()).toEqual(["demo", "notes"]);
    expect(binding.resources).toBe(resources);
    expect(resources.schemes()).toEqual(["demo", "notes"]);
  });

  it("未注入注册表时自建一个（SDK / 测试）", () => {
    const binding = createHostApi({
      mode: "print",
      session: { id: () => "s", file: () => undefined, cwd: () => "/w", model: () => undefined },
      tools: stubRegistry(),
      bus: new AgentEventBus(),
      sendUser: async () => "queued",
      stderr: () => undefined,
    });
    binding.api.resources?.register(ok("demo"));
    expect(binding.resources.schemes()).toEqual(["demo"]);
  });
});
