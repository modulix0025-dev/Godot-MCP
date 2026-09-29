# Built-in ComfyUI workflows

Each folder is one workflow: `workflow.json` (a `WorkflowDefinition`, `studio/shared/src/extensions.ts`) and
`graph.api.json` (the graph exported from ComfyUI with _Save (API)_). `core/src/comfy/registry.ts` loads and
cross-checks them. Every binding and output node must exist, and `required_nodes` must equal the graph's node
classes.

| Workflow             | Produces                        | Status         |
| -------------------- | ------------------------------- | -------------- |
| `CONCEPT_IMAGE.sdxl` | image                           | **UNVERIFIED** |
| `3D_PROP.hunyuan3d2` | mesh only: untextured, unrigged | **UNVERIFIED** |

An UNVERIFIED workflow runs **test** jobs only, such as worker onboarding and the GATE 7 live test. Production
jobs report `BLOCKED workflow_unverified`. A workflow becomes VERIFIED only after a real generation on a real
worker passes output validation. The evidence (worker, ComfyUI version, sha256 of the output) is recorded in
`verification.evidence` and in `docs/modulex/DECISIONS.md`.

The licence facts above come from the model cards. The asset-provenance gate turns `conditional` into owner-visible
conditions and never into "probably fine".
