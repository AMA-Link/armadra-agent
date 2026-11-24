---
version: 2
title: Owns
roles:
  - id: a
    agentId: ama
contract:
  owns:
    ghost: ["src/"]
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
