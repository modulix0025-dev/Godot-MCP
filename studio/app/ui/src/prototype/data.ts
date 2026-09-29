// SPDX-License-Identifier: Apache-2.0
//
// Sample content for the UI Direction Review prototype. Illustrative only — nothing here is live data.
// Stage ids, tool ids, trust levels, profiles and provenance fields match the real contracts in
// studio/shared (manifests.ts, policy.ts, workers.ts, build-profiles.ts, provenance.ts).

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'running' | 'neutral' | 'accent';
export type StageStatus = 'done' | 'running' | 'pending' | 'blocked' | 'failed' | 'partial';

/** Execution Patch 1 §11 creation pipeline (shared/manifests.ts CREATION_PIPELINE). */
export const STAGES: { name: string; status: StageStatus; detail?: string }[] = [
  { name: 'User request', status: 'done' },
  { name: 'Game specification', status: 'done', detail: 'game-spec.json' },
  { name: 'Technical specification', status: 'done' },
  { name: 'Scene manifest', status: 'done', detail: '7 scenes' },
  { name: 'Asset manifest', status: 'done', detail: '7 assets' },
  { name: 'Task graph', status: 'done', detail: '22 tasks' },
  { name: 'Project creation', status: 'done', detail: 'Godot 4.5.1 mono' },
  { name: 'Asset generation', status: 'done', detail: '6/7' },
  { name: 'Asset processing', status: 'running', detail: 'Player · rigging' },
  { name: 'Scene construction', status: 'pending' },
  { name: 'Gameplay', status: 'pending' },
  { name: 'QA', status: 'pending' },
  { name: 'Playtest', status: 'pending' },
  { name: 'Visual inspection', status: 'pending' },
  { name: 'Bug fixes', status: 'pending' },
  { name: 'Regression', status: 'pending' },
  { name: 'Optimization', status: 'pending' },
  { name: 'Build', status: 'pending' },
  { name: 'Export', status: 'pending' },
];

export const PROJECTS = [
  {
    name: 'جزيرة المستكشف',
    subtitle: 'Island Explorer',
    status: { label: 'Building · stage 9/19', tone: 'running' as Tone },
    platforms: [
      { p: 'Win', tone: 'success' as Tone },
      { p: 'Android', tone: 'running' as Tone },
      { p: 'iOS', tone: 'neutral' as Tone },
    ],
    last: '14:02',
    cost: '$3.20',
  },
  {
    name: 'رحلة طفل في الفضاء',
    subtitle: 'Space Kid Journey · via Claude Desktop',
    status: { label: 'Planning complete', tone: 'info' as Tone },
    platforms: [
      { p: 'Win', tone: 'neutral' as Tone },
      { p: 'Android', tone: 'neutral' as Tone },
      { p: 'iOS', tone: 'neutral' as Tone },
    ],
    last: '—',
    cost: '$0.00',
  },
  {
    name: 'Space Runner',
    subtitle: 'Endless runner',
    status: { label: 'Partial success', tone: 'warning' as Tone },
    platforms: [
      { p: 'Win', tone: 'success' as Tone },
      { p: 'Android', tone: 'danger' as Tone },
      { p: 'iOS', tone: 'neutral' as Tone },
    ],
    last: 'Yesterday',
    cost: '$11.75',
  },
];

export const CHAT: { who: 'user' | 'agent'; role?: string; text: string }[] = [
  { who: 'user', text: 'اعمل لعبة 3D للأطفال: مستكشف يجمع النجوم على جزيرة، ثلاث مراحل، وألوان مبهجة.' },
  {
    who: 'agent',
    role: 'Game Director',
    text:
      'Got it — a bright 3D collect-a-thon for kids: an explorer on an island, 3 levels, stars to collect, a ' +
      'simple win screen. I wrote the Game Specification (العربية + English), the scene and asset manifests and a 22-task plan.',
  },
  {
    who: 'agent',
    role: '3D Asset Producer',
    text: '6 of 7 assets are generated, validated and licence-cleared. The Player mesh needs rigging.',
  },
  { who: 'user', text: 'غيّر الشخصية دي تبقى أصغر وأكثر كرتونية' },
];

export interface AssetRow {
  name: string;
  category: string;
  status: string;
  tone: Tone;
  progress?: number;
  tris?: string;
  worker?: string;
}

export const ASSETS: AssetRow[] = [
  {
    name: 'Player — explorer',
    category: '3D_CHARACTER',
    status: 'Needs rig',
    tone: 'warning',
    tris: '18.2k',
    worker: 'remote-gpu-01',
  },
  {
    name: 'Star collectible',
    category: '3D_PROP',
    status: 'Imported',
    tone: 'success',
    tris: '0.9k',
    worker: 'remote-gpu-01',
  },
  {
    name: 'Palm tree',
    category: '3D_PROP',
    status: 'Imported',
    tone: 'success',
    tris: '6.4k',
    worker: 'remote-gpu-02',
  },
  {
    name: 'Island terrain',
    category: '3D_ENVIRONMENT',
    status: 'Validating',
    tone: 'info',
    tris: '44k',
    worker: 'remote-gpu-02',
  },
  {
    name: 'Treasure chest',
    category: '3D_PROP',
    status: 'Generating 63%',
    tone: 'running',
    progress: 63,
    worker: 'remote-gpu-01',
  },
  { name: 'Wooden sign', category: '3D_PROP', status: 'Queued', tone: 'neutral', worker: '—' },
  {
    name: 'Crab enemy',
    category: '3D_CHARACTER',
    status: 'Blocked · licence unknown',
    tone: 'danger',
    worker: 'imported',
  },
];

export const ASSET_CHAIN = ['Reference', 'Mesh', 'Texture', 'Cleanup', 'UV', 'Rig', 'Anim', 'Collision', 'LOD', 'GLB'];

/** Provenance of the selected asset (shared/provenance.ts AssetProvenance). */
export const PROVENANCE: {
  asset: string;
  rows: [string, string][];
  verdict: { tone: Tone; label: string; note: string };
}[] = [
  {
    asset: 'Player — explorer',
    rows: [
      ['Origin', 'Generated'],
      ['Generator', 'ComfyUI 0.37.0'],
      ['Workflow', '3D_CHARACTER.hunyuan3d2 @ 1.2.0'],
      ['Model', 'Hunyuan3D-2 (hunyuan3d-dit-v2-0)'],
      ['Custom nodes', 'none'],
      ['Worker', 'remote-gpu-01 (TRUSTED)'],
      ['Licence', 'tencent-hunyuan-community'],
      ['Created', '2026-09-29 13:41'],
      ['Human modified', 'No'],
    ],
    verdict: {
      tone: 'warning',
      label: 'Commercial use: conditional',
      note: 'Licence terms apply (territory / user thresholds) — shown to the owner before release.',
    },
  },
  {
    asset: 'Crab enemy',
    rows: [
      ['Origin', 'Imported (crab_v2.glb)'],
      ['Generator', '—'],
      ['Source', 'Downloaded file, no licence recorded'],
      ['Licence', 'UNKNOWN'],
      ['Created', '2026-09-28 22:10'],
    ],
    verdict: {
      tone: 'danger',
      label: 'BLOCKED — licence unknown',
      note: 'A release build cannot include this asset until its licence is recorded.',
    },
  },
];

export const TESTS: { name: string; tier: string; status: StageStatus; ms?: number }[] = [
  { name: 'C# build clean', tier: 'Static', status: 'done', ms: 8200 },
  { name: 'script-validate (14 .gd)', tier: 'Static', status: 'done', ms: 1900 },
  { name: 'project-validate-resources', tier: 'Static', status: 'done', ms: 640 },
  { name: 'Boots to main scene < 10 s', tier: 'Playtest', status: 'done', ms: 3100 },
  { name: 'Player moves on move_forward', tier: 'Playtest', status: 'done', ms: 900 },
  { name: 'No fall-through after 2 s', tier: 'Playtest', status: 'failed', ms: 2400 },
  { name: 'HUD visible, no overlap', tier: 'Visual', status: 'failed', ms: 300 },
  { name: 'Level 2 transition', tier: 'Playtest', status: 'pending' },
];

export const CONSOLE_LINES = [
  '[ModuleX-QA] connected',
  '10:41:52 game-state-get → frame 1057 · 60 fps · res://Qa/Main.tscn',
  '10:41:52 game-input-action move_forward hold=30 → released',
  '10:41:52 runtime-errors-get → 1 error (seq 1)',
  "  ERROR  Player.gd:13 in _physics_process: Invalid access to property 'y' on a null instance",
  '10:41:52 game-ui-inspect → overlap Start ⨯ Quit (1200 px²)',
];

export const BUILDS = [
  {
    id: 'b-0013',
    platform: 'Windows',
    profile: 'RELEASE',
    version: '0.3.0',
    status: 'Smoke-tested',
    tone: 'success' as Tone,
    size: '84 MB',
    created: '14:04',
    sha: '71d0…9c3e',
  },
  {
    id: 'b-0012',
    platform: 'Windows',
    profile: 'QA',
    version: '0.3.0',
    status: 'Smoke-tested · 0 runtime errors',
    tone: 'success' as Tone,
    size: '118 MB',
    created: '14:02',
    sha: '9f2c…e1a0',
  },
  {
    id: 'b-0011',
    platform: 'Android APK',
    profile: 'PREVIEW',
    version: '0.3.0',
    status: 'Built, not device-tested',
    tone: 'warning' as Tone,
    size: '64 MB',
    created: '13:58',
    sha: '41be…77d2',
  },
  {
    id: 'b-0010',
    platform: 'iOS',
    profile: 'RELEASE',
    version: '0.3.0',
    status: 'PREPARED — signed build needs macOS worker',
    tone: 'info' as Tone,
    size: '22 MB',
    created: '13:55',
    sha: 'c0d9…3b51',
  },
  {
    id: 'b-0009',
    platform: 'Windows',
    profile: 'RELEASE',
    version: '0.2.4',
    status: 'Failed · C# assemblies missing',
    tone: 'danger' as Tone,
    size: '—',
    created: 'Yesterday',
    sha: '—',
  },
];

export const PROFILE_ROWS: [string, string, string, string][] = [
  ['DEV', 'debug', 'MCP + QA bridge', 'Rapid development, editor integration'],
  ['QA', 'debug', 'MCP + QA bridge', 'Automated tests, screenshots, runtime errors'],
  ['PREVIEW', 'release', 'none', 'Owner previews, file logging on'],
  ['RELEASE', 'release', 'none', 'Customer build: no MCP, no QA bridge, no diagnostics'],
];

export type Trust = 'TRUSTED' | 'DEGRADED' | 'UNTRUSTED' | 'QUARANTINED' | 'OFFLINE';
export const TRUST_TONE: Record<Trust, Tone> = {
  TRUSTED: 'success',
  DEGRADED: 'warning',
  UNTRUSTED: 'neutral',
  QUARANTINED: 'danger',
  OFFLINE: 'neutral',
};

export const WORKERS: {
  id: string;
  gpu: string;
  provider: string;
  location: string;
  comfy: string;
  caps: string[];
  trust: Trust;
  transport: string;
  rate: string;
  queue: number;
  failures: number;
  note?: string;
  onboarding?: [string, 'passed' | 'failed' | 'pending'][];
}[] = [
  {
    id: 'remote-gpu-01',
    gpu: 'RTX 5090 · 32 GB',
    provider: 'Vast.ai',
    location: 'EU-West',
    comfy: 'ComfyUI 0.37.0',
    caps: ['3d', 'image', 'texture'],
    trust: 'TRUSTED',
    transport: 'HTTPS auth proxy',
    rate: '$0.60/h',
    queue: 1,
    failures: 0,
  },
  {
    id: 'remote-gpu-02',
    gpu: 'A100 · 80 GB',
    provider: 'RunPod',
    location: 'US-East',
    comfy: 'ComfyUI 0.36.2',
    caps: ['3d', 'image', 'video'],
    trust: 'QUARANTINED',
    transport: 'Tailscale',
    rate: '$1.40/h',
    queue: 0,
    failures: 3,
    note: 'Quarantined 13:52 — file_validation_failure ×3 (malformed GLB). 2 queued jobs moved to remote-gpu-01. Owner can re-enable.',
  },
  {
    id: 'local-rtx-4070',
    gpu: 'RTX 4070 · 12 GB',
    provider: 'Local',
    location: 'This PC',
    comfy: 'ComfyUI 0.37.0',
    caps: ['image'],
    trust: 'UNTRUSTED',
    transport: 'Loopback',
    rate: 'free',
    queue: 0,
    failures: 0,
    onboarding: [
      ['Register', 'passed'],
      ['Connectivity', 'passed'],
      ['Authentication', 'passed'],
      ['Capability discovery', 'passed'],
      ['Version discovery', 'passed'],
      ['Health check', 'passed'],
      ['Test generation', 'pending'],
      ['Output validation', 'pending'],
    ],
  },
];

export const APPROVALS = [
  {
    requester: 'Claude Desktop',
    role: 'external operator',
    tool: 'studio_asset_delete',
    tier: 'Destructive',
    tone: 'danger' as Tone,
    cost: '—',
    what: "Delete 6 generated asset(s) from 'جزيرة المستكشف'",
    why: 'Owner asked Claude for a completely new art style.',
    scope: 'ALL generated assets of the project',
    files: ['res://assets/generated/3D_PROP/star/star.glb', 'res://assets/generated/3D_PROP/palm/palm.glb', '+4 more'],
    risk: 'high',
    rollback: 'Files move to .modulex/trash/<approval_id>/ (restorable) and a checkpoint is taken first.',
  },
  {
    requester: 'ModuleX Agent',
    role: '3D Asset Producer',
    tool: 'studio_asset_generate',
    tier: 'External cost',
    tone: 'warning' as Tone,
    cost: '$0.40',
    what: 'Regenerate the Player as a smaller, more cartoony explorer',
    why: 'Owner request in the Studio conversation.',
    scope: '1 asset · 3D_CHARACTER.hunyuan3d2 · remote-gpu-01 (TRUSTED)',
    files: ['res://assets/generated/3D_CHARACTER/hero/hero.glb (replaced)'],
    risk: 'low',
    rollback: 'Previous GLB kept in the checkpoint mx-cp-15.',
  },
];

export const ACTIVITY = [
  {
    t: '14:02:11',
    who: 'Build/Release',
    what: 'studio_build windows RELEASE → b-0013 · sha256 71d0…9c3e',
    tone: 'success' as Tone,
  },
  {
    t: '14:01:58',
    who: 'Claude Desktop',
    what: 'claude_approval_requested studio_asset_delete (risk high)',
    tone: 'warning' as Tone,
  },
  { t: '14:01:40', who: 'QA Agent', what: 'game-ui-inspect → overlap Start ⨯ Quit', tone: 'warning' as Tone },
  {
    t: '14:00:47',
    who: 'Policy Gateway',
    what: 'reflection-method-call refused (DEVELOPER_MODE_REQUIRED)',
    tone: 'danger' as Tone,
  },
  {
    t: '13:52:03',
    who: 'Worker trust',
    what: 'remote-gpu-02 → QUARANTINED (file_validation_failure ×3)',
    tone: 'danger' as Tone,
  },
  {
    t: '13:50:12',
    who: 'Claude Desktop',
    what: 'claude_health_test ok (list_tools · safe_ping · project_status)',
    tone: 'success' as Tone,
  },
  { t: '13:49:30', who: 'Studio', what: 'checkpoint mx-cp-14 “before fix attempt 1/3”', tone: 'neutral' as Tone },
];

export interface ProviderCard {
  name: string;
  status: string;
  tone: Tone;
  rows: [string, string][];
  actions: string[];
  note?: string;
}

export const PROVIDERS: ProviderCard[] = [
  {
    name: 'ModuleX Agent',
    status: 'Connected',
    tone: 'success',
    rows: [
      ['Role', 'Primary orchestrator (authoritative)'],
      ['Endpoint', 'modulex-studio MCP · 127.0.0.1:47821/mcp'],
      ['Tool profile', 'Agent-safe studio_* tools (18 live · 39 declared)'],
      ['Last health check', '14:02:30 · ok'],
    ],
    actions: ['Test connection', 'Rotate credential'],
  },
  {
    name: 'Claude Desktop',
    status: 'Connected',
    tone: 'success',
    rows: [
      ['Direction', 'Claude Desktop → ModuleX Game Studio (MCP)'],
      ['Model', 'Claude Opus 5.5 ✓'],
      ['ModuleX MCP', '✓ 16 safe tools · approvals owner-only'],
      ['Authentication', 'Pairing token (Claude Desktop keychain)'],
      ['Last health check', '13:50:12 · list_tools · safe_ping · project_status ✓'],
    ],
    actions: [
      'Install Claude Desktop Extension',
      'Open Claude Desktop',
      'Copy pairing token',
      'Verify connection',
      'Disconnect',
    ],
  },
  {
    name: 'Claude API',
    status: 'Configured',
    tone: 'success',
    rows: [
      ['Model', 'claude-opus-5-5'],
      ['Effort', 'medium (default)'],
      ['Thinking', 'Adaptive — always on (no switch on Opus 5.5)'],
      ['Refusal fallback', 'Server-side “default” · on'],
      ['API key', '•••• stored in Windows Credential Manager'],
      ['Last health check', '14:00:05 · ok · 412 ms'],
    ],
    actions: ['Edit', 'Test connection'],
  },
  {
    name: 'Local Agent SDK',
    status: 'Unavailable',
    tone: 'neutral',
    rows: [
      ['Status', 'Not offered in ModuleX Game Studio'],
      [
        'Why',
        'Anthropic does not allow third-party products to use claude.ai login / subscription limits; an API-key Agent SDK path bills like the Claude API but brings its own file/shell tools outside the Studio gateway.',
      ],
    ],
    actions: ['Use Claude API instead'],
  },
  {
    name: 'Other providers',
    status: 'None',
    tone: 'neutral',
    rows: [['Configured', '—']],
    actions: ['Add provider'],
  },
];

export const ROUTING: [string, string][] = [
  ['Primary', 'Claude API · claude-opus-5-5 · medium'],
  ['Planning', 'Claude API · claude-opus-5-5 · high'],
  ['QA', 'Claude API · claude-opus-5-5 · medium'],
  ['Fast', 'Claude API · claude-sonnet-5-5 · low'],
  ['Fallback', 'Not set (uses Primary)'],
];
