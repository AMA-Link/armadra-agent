---
version: 2
title: Split a feature into API and UI
params:
  - name: feature
    type: text
    label: What to build
roles:
  - id: api
    agentId: ama
    tier: strong
    worktree: api
  - id: ui
    agentId: ama
    tier: standard
    worktree: ui
  - id: lead
    agentId: ama
    tier: strong
contract:
  text: |
    Interface: POST /api/items -> { id: string }
    Constraint: no new runtime dependencies.
  owns:
    api: ["src/server/"]
    ui: ["src/web/**"]
steps:
  - id: build-api
    kind: prompt
    role: api
    prompt: "Implement the server side of {{feature}}."
  - id: build-ui
    kind: prompt
    role: ui
    prompt: "Implement the UI of {{feature}} against the contract."
  - id: review
    kind: gate
    label: Review both parts before merging
    after: [build-api, build-ui]
  - id: integrate
    kind: collect
    role: lead
    from: [build-api, build-ui]
    after: [review, build-api, build-ui]
    prompt: Merge both branches and summarize what changed.
    verify:
      commands: ["pnpm test"]
      checklist: ["The API route exists", "The UI calls it"]
    maxRetries: 1
---

For people: this workflow builds the API and the UI in parallel.

It is never sent to a model.
