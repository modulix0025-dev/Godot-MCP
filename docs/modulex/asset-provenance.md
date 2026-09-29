# ModuleX Game Studio: asset provenance

Every asset the Studio generates or imports carries a **provenance record**: where it came from, what
produced it, and the licence of every component that contributed to it. The commercial-use verdict is
**derived** from those facts. It is never asserted, and anything the Studio cannot establish is
**BLOCKED**, not "probably fine".

Contract: `studio/shared/src/provenance.ts`. Tests: `studio/shared/tests/contracts.test.ts` ("asset
provenance", "completion predicate").

## 1. The record (`AssetProvenanceSchema`)

| Field | Meaning |
|---|---|
| `asset_id`, `asset_type` | The asset. The type is one of character, prop, environment, texture, material, concept_image, animation, audio or ui. |
| `source` | `generated` / `imported` / `procedural` / `manual` |
| `generator` | For example `ComfyUI 0.37.0`. It is null for manual or imported assets. |
| `workflow_id`, `workflow_version` | The registry workflow, for example `3D_CHARACTER.hunyuan3d2` @ `1.2.0` |
| `model`, `checkpoint`, `custom_nodes` | What actually ran |
| `worker_id` | The worker **id** only (`remote-gpu-01`), never its URL or credentials |
| `generated_at` | An ISO timestamp with an offset |
| `source_reference` | The prompt id, the original file name or the store URL |
| `human_modified` | Whether a person edited the output |
| `license_facts[]` | One per contributing component: `subject` (such as `model:Hunyuan3D-2`), `license` (an SPDX id or a recorded name, or `UNKNOWN`), `commercial_use` (`allowed`/`conditional`/`forbidden`/`unknown`), `conditions`, `evidence_url`, `recorded_by` (`workflow-registry`/`owner`/`import`) |
| `sha256` | The hash of the exact artifact this record describes |

For generated assets, `generator`, `workflow_id`, `workflow_version` and `worker_id` are **required**.

## 2. The verdict (`evaluateCommercialUse`)

The checks run in order, and the first failure wins:

1. The record is missing or invalid: **BLOCKED** `PROVENANCE_MISSING`.
2. There are no licence facts: **BLOCKED** `LICENSE_UNKNOWN`.
3. Any fact is `forbidden` (a non-commercial licence, for example): **BLOCKED** `COMMERCIAL_USE_FORBIDDEN`.
4. Any fact is `unknown`, or its licence is `UNKNOWN`: **BLOCKED** `LICENSE_UNKNOWN`.
5. A generated asset whose `model` has no `model:<model>` fact: **BLOCKED** `LICENSE_UNKNOWN`.
6. Otherwise: **ALLOWED**, with the distinct licences and every `conditions` string. Conditional terms
   are surfaced to the owner and never dropped.

## 3. Where it is enforced

- **The asset manifest.** Every entry references a `provenance_id` (`AssetManifestSchema`).
- **`studio_asset_status`** returns the provenance together with its verdict, so ModuleX Agent and Claude
  both see *why* an asset is blocked.
- **The completion predicate.** `evaluateCompletion` has two evidence rows, `assets.provenanceComplete`
  and `assets.commercialUseCleared`. If either is missing (`null`) or failing (`false`), SUCCESS is
  impossible, and the row is named in `missing` or `failed`. Phase 12 computes these rows from the asset
  manifest and `evaluateCommercialUse`.
- **Release builds.** A RELEASE build must not include a BLOCKED asset. This check runs in the Phase 10
  build step, which reads the same verdict (see [`build-profiles.md`](build-profiles.md)).
- **Audit.** The catalogue declares `asset_provenance_recorded` and `asset_license_blocked`. The
  generation pipeline (Phase 7) emits them.

## 4. Where licence facts come from

- **The workflow registry** (Phase 7). Each registered workflow declares the licence of its model
  weights, checkpoints and required custom nodes, with an evidence URL. The facts are copied into every
  asset that workflow produces (`recorded_by: workflow-registry`).
- **The owner**, for imported or third-party files (`recorded_by: owner`). An import without a recorded
  licence is `UNKNOWN`, and so it is BLOCKED until the owner records one.

The Studio never infers a licence from a file name, a store page or a model's popularity.

## 5. The UI (Assets → detail)

The provenance panel shows:

- origin;
- generator;
- workflow and version;
- model;
- custom nodes;
- worker (the id and its trust level);
- licence;
- **commercial use** (a semantic pill: Allowed, Conditional or **BLOCKED — licence unknown**);
- the created date;
- whether it was human-modified.

See `docs/modulex/ui/screens/assets-*.png`.

## 6. Known limitation

The contract, the verdict, the manifest links and the completion gate are implemented and tested. The
generation pipeline that *writes* these records (Phase 7, the ComfyUI workers) and the RELEASE build gate
(Phase 10) are not built yet. Until they are, `studio_asset_status` reports whatever records the store
holds.
