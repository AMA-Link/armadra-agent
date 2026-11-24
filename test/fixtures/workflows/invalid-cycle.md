---
version: 2
title: Cycle
roles:
  - id: a
    agentId: ama
steps:
  - id: s1
    kind: prompt
    role: a
    prompt: x
    after: [s2]
  - id: s2
    kind: prompt
    role: a
    prompt: y
    after: [s1]
---
