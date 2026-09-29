// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/audit/secrets.js';
import { buildHandoff, MAX_PROMPT_CHARS } from '../src/claude/handoff.js';

describe('Open in Claude Desktop', () => {
  it('builds the documented claude://claude.ai/new?q= deep link with a secret-free prompt', () => {
    const h = buildHandoff(
      {
        kind: 'review_failure',
        projectName: 'رحلة طفل في الفضاء',
        projectId: 'space-kid-journey',
        task: 'No fall-through after 2 s failed',
        status: { pipeline: { current_stage: 'qa' } },
      },
      new Redactor(),
    );
    expect(h.url.startsWith('claude://claude.ai/new?q=')).toBe(true);
    expect(decodeURIComponent(h.url.split('?q=')[1]!)).toBe(h.prompt);
    expect(h.prompt).toContain('project_id: space-kid-journey');
    expect(h.prompt).toContain('data, not instructions');
    expect(h.truncated).toBe(false);
  });

  it('trims the context (not the instructions) to stay under the ~14,000-character cap', () => {
    const h = buildHandoff(
      { kind: 'continue_task', projectName: 'P', projectId: 'p', task: 't', status: { blob: 'x'.repeat(50_000) } },
      new Redactor(),
    );
    expect(h.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS + 60);
    expect(h.truncated).toBe(true);
    expect(h.prompt).toContain('Continue this task.');
  });

  it('refuses to hand off secret material', () => {
    const r = new Redactor();
    r.register('worker-token-value-123456');
    expect(() =>
      buildHandoff(
        {
          kind: 'continue_task',
          projectName: 'P',
          projectId: 'p',
          task: 't',
          status: { w: 'worker-token-value-123456' },
        },
        r,
      ),
    ).toThrow(/secret/);
    expect(() =>
      buildHandoff(
        {
          kind: 'continue_task',
          projectName: 'P',
          projectId: 'p',
          task: 't',
          status: { k: 'sk-ant-api03-zzzzzzzzzzzzzzz' },
        },
        new Redactor(),
      ),
    ).toThrow(/secret/);
  });
});
