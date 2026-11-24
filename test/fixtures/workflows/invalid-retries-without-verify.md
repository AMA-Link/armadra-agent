---
version: 2
title: Retries
roles:
  - id: a
    agentId: ama
steps:
  - id: s1
    kind: prompt
    role: a
    prompt: x
  - id: c
    kind: collect
    role: a
    from: [s1]
    after: [s1]
    prompt: gather
    maxRetries: 1
---
