---
version: 2
title: Two-reviewer code review
params:
  - name: repo
    type: path
  - name: scopeA
    default: src/a
roles:
  - id: reviewerA
    agentId: claude
    permissionMode: plan
  - id: reviewerB
    agentId: custom:reviewer
  - id: lead
    agentId: codex
    permissionMode: default
links:
  - from: lead
    to: reviewerA
steps:
  - id: s1
    kind: prompt
    role: reviewerA
    prompt: Review {{scopeA}} in {{repo}}
  - id: s2
    kind: prompt
    role: reviewerB
    prompt: Review B
  - id: s3
    kind: collect
    role: lead
    from: [s1, s2]
    after: [s1, s2]
    prompt: Summarize both reviews
  - id: s4
    kind: gate
    label: Human check before merging
    after: [s3]
source:
  boardId: board-1
  nodeIds: [n1, n2]
  proposedBy: ama
---
