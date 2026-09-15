# Agent Message Protocol

Agents should communicate using task artifacts.

Input:
- task.json
- relevant repository evidence
- selected memory context
- explicit questions

Output:
- report.json
- optional supporting notes

A report must be self-contained enough for the orchestrator to reconcile without replaying the entire conversation.
