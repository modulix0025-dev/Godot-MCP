// SPDX-License-Identifier: Apache-2.0
//
// Built-in workflow registry (Phase 7): `studio/workflows/<id>/workflow.json` + `graph.api.json`. Loading
// cross-checks the definition against its graph so a broken binding fails at startup, not on a worker.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@modulex/shared';
import type { JobRequest } from './jobs.js';

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  graph: JobRequest['graph'];
}

/** Problems between a definition and its API graph (empty = consistent). */
export function workflowProblems(def: WorkflowDefinition, graph: JobRequest['graph']): string[] {
  const out: string[] = [];
  for (const [input, bind] of Object.entries(def.bindings ?? {})) {
    if (!(input in def.inputs)) out.push(`binding for undeclared input '${input}'`);
    const [node, , field] = bind.split('.');
    if (!graph[node!]) out.push(`binding ${input} → node '${node}' is not in the graph`);
    else if (!(field! in graph[node!]!.inputs)) out.push(`binding ${input} → ${node}.inputs.${field} does not exist`);
  }
  for (const [input, spec] of Object.entries(def.inputs))
    if (!def.bindings?.[input] && spec.type !== 'seed') out.push(`input '${input}' has no binding`);
  for (const [name, o] of Object.entries(def.output_nodes ?? {})) {
    if (!(name in def.outputs)) out.push(`output node for undeclared output '${name}'`);
    if (!graph[o.node]) out.push(`output '${name}' → node '${o.node}' is not in the graph`);
  }
  for (const name of Object.keys(def.outputs))
    if (!def.output_nodes?.[name]) out.push(`output '${name}' has no output node`);
  const classes = [...new Set(Object.values(graph).map((n) => n.class_type))].sort();
  const required = [...new Set(def.required_nodes ?? [])].sort();
  if (JSON.stringify(classes) !== JSON.stringify(required))
    out.push(`required_nodes (${required.join(', ')}) must equal the graph's node classes (${classes.join(', ')})`);
  for (const [id, n] of Object.entries(graph))
    for (const v of Object.values(n.inputs))
      if (Array.isArray(v) && typeof v[0] === 'string' && !graph[v[0]])
        out.push(`node ${id} links to missing node ${v[0]}`);
  return out;
}

export function loadWorkflows(dir: string): LoadedWorkflow[] {
  if (!existsSync(dir)) return [];
  const out: LoadedWorkflow[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const base = join(dir, entry.name);
    const def = WorkflowDefinitionSchema.parse(JSON.parse(readFileSync(join(base, 'workflow.json'), 'utf-8')));
    if (def.id !== entry.name) throw new Error(`${entry.name}: workflow id '${def.id}' must match its folder`);
    const graph = JSON.parse(readFileSync(join(base, def.graph), 'utf-8')) as JobRequest['graph'];
    const problems = workflowProblems(def, graph);
    if (problems.length) throw new Error(`${def.id}: ${problems.join('; ')}`);
    out.push({ definition: def, graph });
  }
  return out.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
}
