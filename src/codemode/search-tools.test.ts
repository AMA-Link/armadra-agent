import { describe, expect, it } from "vitest";
import { searchTools, tokenize } from "./search-tools.js";

const tools = [
  { name: "read", description: "Read a file from disk. Images come back as attachments." },
  { name: "grep", description: "Search file contents with a regular expression." },
  { name: "glob", description: "Find files by name pattern." },
  { name: "bash", description: "Run a shell command." },
  { name: "canvas_add_note", description: "Add a sticky note to the canvas." },
  { name: "canvas_list_nodes", description: "List nodes on the canvas." },
  { name: "deploy_status", description: "Show the deploy status of a service." },
];

describe("searchTools", () => {
  it("tokenize：小写、按非字母数字与驼峰切词", () => {
    expect(tokenize("read_file listNodes-2")).toEqual(["read", "file", "list", "nodes", "2"]);
  });

  it("按 BM25 排序：名字与描述里的词都算", () => {
    expect(searchTools(tools, "search files regular expression").map((h) => h.name)[0]).toBe(
      "grep",
    );
    expect(searchTools(tools, "sticky note")[0]?.name).toBe("canvas_add_note");
    expect(searchTools(tools, "deploy")[0]?.name).toBe("deploy_status");
  });

  it("结果是 { name, description }，描述取首段并截短", () => {
    const hits = searchTools(
      [{ name: "long", description: `first line\nsecond ${"x".repeat(500)}\n\nsecond para` }],
      "first",
    );
    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]!)).toEqual(["name", "description"]);
    expect(hits[0]!.description.length).toBeLessThanOrEqual(240);
    expect(hits[0]!.description.startsWith("first line second")).toBe(true);
  });

  it("缺省 8 条，limit 可调，上限 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `tool_${i}`,
      description: "shared words",
    }));
    expect(searchTools(many, "shared")).toHaveLength(8);
    expect(searchTools(many, "shared", { limit: 3 })).toHaveLength(3);
    expect(searchTools(many, "shared", { limit: 500 })).toHaveLength(50);
  });

  it("namespace：只在该前缀的工具里搜", () => {
    const names = searchTools(tools, "canvas", { namespace: "canvas" }).map((h) => h.name);
    expect(names.sort()).toEqual(["canvas_add_note", "canvas_list_nodes"]);
    expect(searchTools(tools, "files", { namespace: "canv" })).toEqual([]);
    expect(searchTools(tools, "read", { namespace: "canvas" })).toEqual([]);
  });

  it("没有命中、空查询 → 空数组；同分按名字稳定排序", () => {
    expect(searchTools(tools, "zzzz")).toEqual([]);
    expect(searchTools(tools, "   ")).toEqual([]);
    const same = [
      { name: "b_tool", description: "alpha" },
      { name: "a_tool", description: "alpha" },
    ];
    expect(searchTools(same, "alpha").map((h) => h.name)).toEqual(["a_tool", "b_tool"]);
  });

  it("参数不合法抛 TypeError", () => {
    expect(() => searchTools(tools, 1)).toThrow(TypeError);
    expect(() => searchTools(tools, "x", { limit: 0 })).toThrow("limit");
    expect(() => searchTools(tools, "x", { limit: 1.5 })).toThrow("limit");
    expect(() => searchTools(tools, "x", { namespace: 3 as unknown as string })).toThrow(
      "namespace",
    );
    expect(() => searchTools(tools, "x", null)).toThrow("options");
  });
});
