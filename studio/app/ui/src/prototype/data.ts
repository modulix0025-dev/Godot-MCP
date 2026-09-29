// SPDX-License-Identifier: Apache-2.0
//
// Sample content for the UI Direction Review prototype. Illustrative only — nothing here is live data.
// Stage names, tool ids and statuses match the real contracts (EXECUTION_PROMPT Phase 5/6, the addon tools).

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'running' | 'neutral' | 'accent';
export type StageStatus = 'done' | 'running' | 'pending' | 'blocked' | 'failed' | 'partial';

export const STAGES: { name: string; status: StageStatus; detail?: string }[] = [
  { name: 'Brief', status: 'done' },
  { name: 'Game design doc', status: 'done' },
  { name: 'Tech architecture', status: 'done' },
  { name: 'Project creation', status: 'done', detail: 'Godot 4.5.1 mono' },
  { name: 'Scene planning', status: 'done', detail: '3 scenes' },
  { name: 'Gameplay systems', status: 'done' },
  { name: 'Asset planning', status: 'done', detail: '7 assets' },
  { name: '3D generation', status: 'done', detail: '6/7' },
  { name: 'Asset processing', status: 'running', detail: 'Player · rigging' },
  { name: 'Scene integration', status: 'pending' },
  { name: 'Gameplay implementation', status: 'pending' },
  { name: 'Automated tests', status: 'pending' },
  { name: 'Runtime playtest', status: 'pending' },
  { name: 'Visual inspection', status: 'pending' },
  { name: 'Error detection', status: 'pending' },
  { name: 'Auto-fix', status: 'pending' },
  { name: 'Regression', status: 'pending' },
  { name: 'Optimisation', status: 'pending' },
  { name: 'Build', status: 'pending' },
  { name: 'Export', status: 'pending' },
];

export const PROJECTS = [
  {
    name: 'جزيرة المستكشف',
    subtitle: 'Island Explorer',
    status: { label: 'Building · stage 9/20', tone: 'running' as Tone },
    platforms: [
      { p: 'Win', tone: 'success' as Tone },
      { p: 'Android', tone: 'running' as Tone },
      { p: 'iOS', tone: 'neutral' as Tone },
    ],
    last: '14:02',
    cost: '$3.20',
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
  {
    name: 'Crate Keeper',
    subtitle: 'Puzzle · 3D',
    status: { label: 'Complete', tone: 'success' as Tone },
    platforms: [
      { p: 'Win', tone: 'success' as Tone },
      { p: 'Android', tone: 'success' as Tone },
      { p: 'iOS', tone: 'info' as Tone },
    ],
    last: 'Mon',
    cost: '$6.10',
  },
];

export const CHAT: { who: 'user' | 'agent'; role?: string; text: string }[] = [
  { who: 'user', text: 'اعمل لعبة 3D للأطفال: مستكشف يجمع النجوم على جزيرة، ثلاث مراحل، وألوان مبهجة.' },
  {
    who: 'agent',
    role: 'Game Director',
    text:
      'Got it — a bright 3D collect-a-thon for kids: an explorer on an island, 3 levels, stars to collect, a ' +
      'simple win screen. I drafted the design doc (العربية + English) and a 20-stage plan. 7 assets are needed.',
  },
  {
    who: 'agent',
    role: '3D Asset Producer',
    text: '6 of 7 assets are generated and validated. The Player mesh needs rigging.',
  },
  { who: 'user', text: 'غيّر الشخصية دي تبقى أصغر وأكثر كرتونية' },
];

export const ASSETS: {
  name: string;
  category: string;
  status: string;
  tone: Tone;
  progress?: number;
  tris?: string;
  worker?: string;
}[] = [
  {
    name: 'Player — explorer',
    category: '3D_CHARACTER',
    status: 'Needs rig',
    tone: 'warning',
    tris: '18.2k',
    worker: 'Remote GPU #1',
  },
  {
    name: 'Star collectible',
    category: '3D_PROP',
    status: 'Imported',
    tone: 'success',
    tris: '0.9k',
    worker: 'Remote GPU #1',
  },
  {
    name: 'Palm tree',
    category: '3D_PROP',
    status: 'Imported',
    tone: 'success',
    tris: '6.4k',
    worker: 'Remote GPU #2',
  },
  {
    name: 'Island terrain',
    category: '3D_ENVIRONMENT',
    status: 'Validating',
    tone: 'info',
    tris: '44k',
    worker: 'Remote GPU #2',
  },
  {
    name: 'Treasure chest',
    category: '3D_PROP',
    status: 'Generating 63%',
    tone: 'running',
    progress: 63,
    worker: 'Remote GPU #1',
  },
  { name: 'Wooden sign', category: '3D_PROP', status: 'Queued', tone: 'neutral', worker: '—' },
  { name: 'Crab enemy', category: '3D_CHARACTER', status: 'Failed · oom', tone: 'danger', worker: 'Remote GPU #2' },
];

export const ASSET_CHAIN = ['Reference', 'Mesh', 'Texture', 'Cleanup', 'UV', 'Rig', 'Anim', 'Collision', 'LOD', 'GLB'];

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
    id: 'b-0012',
    platform: 'Windows',
    version: '0.3.0',
    status: 'Smoke-tested',
    tone: 'success' as Tone,
    size: '118 MB',
    created: '14:02',
    sha: '9f2c…e1a0',
  },
  {
    id: 'b-0011',
    platform: 'Android APK',
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
    version: '0.3.0',
    status: 'Prepared (no macOS worker)',
    tone: 'info' as Tone,
    size: '22 MB',
    created: '13:55',
    sha: 'c0d9…3b51',
  },
  {
    id: 'b-0009',
    platform: 'Windows',
    version: '0.2.4',
    status: 'Failed · C# assemblies missing',
    tone: 'danger' as Tone,
    size: '—',
    created: 'Yesterday',
    sha: '—',
  },
];

export const WORKERS = [
  {
    name: 'Remote GPU #1',
    gpu: 'RTX 5090 · 32 GB',
    provider: 'Vast.ai',
    comfy: 'ComfyUI 0.37',
    caps: ['3d', 'image', 'texture'],
    status: 'Online',
    tone: 'success' as Tone,
    rate: '$0.60/h',
    queue: 1,
  },
  {
    name: 'Remote GPU #2',
    gpu: 'A100 · 80 GB',
    provider: 'RunPod',
    comfy: 'ComfyUI 0.36',
    caps: ['3d', 'image', 'video'],
    status: 'Degraded',
    tone: 'warning' as Tone,
    rate: '$1.40/h',
    queue: 3,
  },
  {
    name: 'Mac build worker',
    gpu: 'M3 Pro · Xcode 26',
    provider: 'Owner',
    comfy: 'Godot 4.5.1 mono',
    caps: ['ios', 'signing'],
    status: 'Offline',
    tone: 'neutral' as Tone,
    rate: '—',
    queue: 0,
  },
];

export const APPROVALS = [
  {
    role: 'Technical Artist',
    tool: 'resource-delete',
    args: 'res://assets/generated/3D_PROP/old_chest/chest.glb',
    why: 'Replacing the chest with the regenerated version.',
    tier: 'Destructive',
    tone: 'danger' as Tone,
    cost: '—',
  },
  {
    role: '3D Asset Producer',
    tool: 'studio_asset_request',
    args: '3D_CHARACTER · "smaller, more cartoony explorer" · hunyuan3d2',
    why: 'Owner asked for a smaller, more cartoony character.',
    tier: 'External cost',
    tone: 'warning' as Tone,
    cost: '$0.40',
  },
];

export const ACTIVITY = [
  {
    t: '14:02:11',
    who: 'Build/Release',
    what: 'studio_build windows → b-0012 · sha256 9f2c…e1a0',
    tone: 'success' as Tone,
  },
  { t: '14:01:40', who: 'QA Agent', what: 'game-ui-inspect → overlap Start ⨯ Quit', tone: 'warning' as Tone },
  {
    t: '14:01:02',
    who: 'Gameplay Engineer',
    what: 'script-update res://player/player.gd (+12 −3)',
    tone: 'accent' as Tone,
  },
  {
    t: '14:00:47',
    who: 'Policy Gateway',
    what: 'reflection-method-call refused (Disabled tier)',
    tone: 'danger' as Tone,
  },
  { t: '13:59:30', who: 'Studio', what: 'checkpoint mx-cp-14 “before fix attempt 1/3”', tone: 'neutral' as Tone },
];
