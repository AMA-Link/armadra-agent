import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { globsOverlap, validateOwnsGlob } from "./glob.js";

interface Vectors {
  overlap: { a: string; b: string; overlap: boolean }[];
  valid: { glob: string; valid: boolean }[];
}
const vectors = JSON.parse(
  readFileSync(new URL("../../schema/workflow-glob-vectors.json", import.meta.url), "utf8"),
) as Vectors;

describe("glob vectors", () => {
  it("has enough vectors", () => {
    expect(vectors.overlap.length + vectors.valid.length).toBeGreaterThanOrEqual(40);
  });
  it.each(vectors.valid)("valid $glob -> $valid", ({ glob, valid }) => {
    expect(validateOwnsGlob(glob) === undefined).toBe(valid);
  });
  it.each(vectors.overlap)("overlap $a ~ $b -> $overlap", ({ a, b, overlap }) => {
    expect(globsOverlap(a, b)).toBe(overlap);
    expect(globsOverlap(b, a)).toBe(overlap);
  });
});

describe("validateOwnsGlob reasons", () => {
  it("names the reason", () => {
    expect(validateOwnsGlob("")).toBe("empty");
    expect(validateOwnsGlob("/a")).toMatch(/start with/);
    expect(validateOwnsGlob("a/../b")).toMatch(/\.\./);
    expect(validateOwnsGlob("a/{b,c}")).toMatch(/\{/);
    expect(validateOwnsGlob("a//b")).toMatch(/empty segment/);
  });
});
