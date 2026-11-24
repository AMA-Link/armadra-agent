---
version: 2
title: Glob
roles:
  - id: a
    agentId: ama
contract:
  owns:
    a: ["../outside"]
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
