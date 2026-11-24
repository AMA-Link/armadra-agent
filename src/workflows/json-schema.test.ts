import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workflowJsonSchema } from "./json-schema.js";

const file = new URL("../../schema/workflow.schema.json", import.meta.url);
const generated = `${JSON.stringify(workflowJsonSchema(), null, 2)}\n`;

describe("workflow JSON Schema", () => {
  it("matches schema/workflow.schema.json byte for byte", () => {
    if (process.env.AMA_UPDATE_SCHEMA === "1") writeFileSync(file, generated);
    expect(readFileSync(file, "utf8")).toBe(generated);
  });
  it("has the frozen identity and closed objects", () => {
    const s = workflowJsonSchema() as Record<string, any>;
    expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(s.$id).toBe("urn:armadra:ama-workflow:2");
    expect(s.additionalProperties).toBe(false);
    for (const def of [
      "param",
      "role",
      "link",
      "verify",
      "contract",
      "source",
      "promptStep",
      "collectStep",
      "gateStep",
    ]) {
      expect(s.$defs[def].additionalProperties, def).toBe(false);
    }
    expect(s.$defs.step.oneOf).toHaveLength(3);
    expect(s.$defs.role.properties.agentId.pattern).toContain("custom:");
  });
});
