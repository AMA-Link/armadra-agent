---
version: 2
title: Overlap
roles:
  - id: a
    agentId: ama
  - id: b
    agentId: ama
contract:
  owns:
    a: ["src/**"]
    b: ["src/web/"]
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
