/**
 * [#318] 工作流 JSON Schema（多 Agent 工作流设计稿 §4.3、§5.7）：draft 2020-12，由常量生成。
 * 跨字段规则（引用存在、无环、from ⊆ after、owns 方言与求交、maxRetries 需 verify）表达不了，另需 `validateWorkflow`。
 * 纯函数，属于 `./workflow` 入口。
 */
import { TIER_LADDER } from "../agents/tier-ladder.js";
import {
  WORKFLOW_AGENT_ID_PATTERN,
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_LIMITS as L,
  WORKFLOW_PARAM_PATTERN,
  WORKFLOW_PARAM_TYPES,
  WORKFLOW_PERMISSION_MODES,
} from "./types.js";

type Schema = Record<string, unknown>;

const nullable = (schema: Schema): Schema => {
  const type = schema.type;
  if (typeof type === "string") return { ...schema, type: [type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
};
const text = (max: number): Schema => ({ type: "string", minLength: 1, maxLength: max });
const ident: Schema = { type: "string", pattern: WORKFLOW_ID_PATTERN.source };
const idList = (min: number): Schema => ({
  type: "array",
  ...(min > 0 ? { minItems: min } : {}),
  maxItems: L.steps,
  items: { $ref: "#/$defs/id" },
});
const strings = (maxItems: number, maxLength: number): Schema => ({
  type: "array",
  maxItems,
  items: text(maxLength),
});
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const object = (properties: Schema, required: string[]): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export function workflowJsonSchema(): Record<string, unknown> {
  const stepBase = {
    id: ref("id"),
    after: nullable(idList(0)),
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:armadra:ama-workflow:2",
    title: "Workflow",
    description:
      "A multi-agent workflow (format version 2). Cross-field rules (references exist, no cycles, " +
      "collect from is a subset of after, contract.owns globs and overlaps, maxRetries needs verify) " +
      "need validateWorkflow() in addition to this schema.",
    ...object(
      {
        version: { const: WORKFLOW_FORMAT_VERSION },
        title: text(L.title),
        description: nullable(text(L.description)),
        params: nullable({ type: "array", maxItems: L.params, items: ref("param") }),
        roles: { type: "array", minItems: 1, maxItems: L.roles, items: ref("role") },
        links: nullable({ type: "array", maxItems: L.links, items: ref("link") }),
        steps: { type: "array", minItems: 1, maxItems: L.steps, items: ref("step") },
        contract: nullable(ref("contract")),
        source: nullable(ref("source")),
      },
      ["version", "title", "roles", "steps"],
    ),
    $defs: {
      id: ident,
      param: object(
        {
          name: { type: "string", pattern: WORKFLOW_PARAM_PATTERN.source },
          type: nullable({ type: "string", enum: [...WORKFLOW_PARAM_TYPES] }),
          label: nullable(text(L.label)),
          default: nullable({ type: "string", maxLength: L.paramValue }),
        },
        ["name"],
      ),
      role: object(
        {
          id: ref("id"),
          agentId: { type: "string", pattern: WORKFLOW_AGENT_ID_PATTERN.source },
          title: nullable(text(L.title)),
          permissionMode: nullable({ type: "string", enum: [...WORKFLOW_PERMISSION_MODES] }),
          model: nullable(text(L.model)),
          worktree: nullable(text(L.worktree)),
          tier: nullable({ type: "string", enum: [...TIER_LADDER] }),
        },
        ["id", "agentId"],
      ),
      link: object(
        {
          from: ref("id"),
          to: ref("id"),
          role: nullable({ type: "string", enum: ["peer", "supervises"] }),
        },
        ["from", "to"],
      ),
      verify: {
        ...object(
          {
            commands: nullable(strings(L.verifyCommands, L.verifyItem)),
            checklist: nullable(strings(L.checklist, L.verifyItem)),
          },
          [],
        ),
        description: "At least one command or checklist item is required.",
      },
      contract: {
        ...object(
          {
            text: nullable(text(L.contractText)),
            owns: nullable({
              type: "object",
              additionalProperties: {
                type: "array",
                maxItems: L.ownsPerRole,
                items: text(L.glob),
              },
            }),
          },
          [],
        ),
        description: "At least one of text and owns is required.",
      },
      source: object(
        {
          boardId: nullable(text(200)),
          nodeIds: nullable({ type: "array", maxItems: 64, items: { type: "string" } }),
          proposedBy: nullable(text(64)),
          sessionId: nullable(text(200)),
        },
        [],
      ),
      step: {
        oneOf: [ref("promptStep"), ref("collectStep"), ref("gateStep")],
      },
      promptStep: object(
        {
          id: stepBase.id,
          kind: { const: "prompt" },
          role: ref("id"),
          prompt: text(L.prompt),
          after: stepBase.after,
        },
        ["id", "kind", "role", "prompt"],
      ),
      collectStep: object(
        {
          id: stepBase.id,
          kind: { const: "collect" },
          role: ref("id"),
          from: idList(1),
          prompt: text(L.prompt),
          after: stepBase.after,
          verify: nullable(ref("verify")),
          maxRetries: nullable({ type: "integer", minimum: 0, maximum: L.maxRetries }),
        },
        ["id", "kind", "role", "from", "prompt"],
      ),
      gateStep: object(
        {
          id: stepBase.id,
          kind: { const: "gate" },
          label: text(L.label),
          after: stepBase.after,
        },
        ["id", "kind", "label"],
      ),
    },
  };
}
