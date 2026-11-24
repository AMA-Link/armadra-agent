---
version: 2
title: Collect
roles:
  - id: a
    agentId: ama
steps:
  - id: s1
    kind: prompt
    role: a
    prompt: x
  - id: s2
    kind: prompt
    role: a
    prompt: y
  - id: c
    kind: collect
    role: a
    from: [s1, s2]
    after: [s1]
    prompt: gather
---
