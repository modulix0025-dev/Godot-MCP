// SPDX-License-Identifier: Apache-2.0
//
// A complete, valid Game Specification (the Execution Patch 1 §30 scenario). Used by tests, by the
// `studio_game_create` tool description as the canonical shape, and by the UI prototype.
import type { GameSpec } from './manifests.js';

export const SAMPLE_GAME_SPEC: GameSpec = {
  schema: 1,
  project: {
    id: 'space-kid-journey',
    name: 'رحلة طفل في الفضاء',
    language: 'ar',
    brief: 'اعمل لعبة 3D عن رحلة طفل في الفضاء، 5 مراحل، نظام نقاط، ومتجر.',
  },
  genre: '3D collect-and-explore adventure',
  target_audience: 'Children 7–12',
  platforms: ['windows', 'android', 'ios'],
  game_loop: 'Fly between small planets, collect stars, avoid meteors, spend stars in the shop between levels.',
  player: { description: 'A child astronaut in a bright suit', abilities: ['move', 'jump', 'jetpack boost'] },
  characters: [
    { id: 'kid', name: 'Kid astronaut', role: 'player', needs_rig: true },
    { id: 'robot', name: 'Helper robot', role: 'shopkeeper', needs_rig: false },
  ],
  world: 'A friendly solar system of five tiny planets.',
  levels: [1, 2, 3, 4, 5].map((n) => ({
    id: `level_${n}`,
    name: `Planet ${n}`,
    goal: 'Collect 20 stars and reach the rocket',
    scene: `level_${n}`,
  })),
  scenes: [
    { id: 'main_menu', purpose: 'Title, start, settings' },
    ...[1, 2, 3, 4, 5].map((n) => ({ id: `level_${n}`, purpose: `Planet ${n} gameplay` })),
    { id: 'shop', purpose: 'Spend stars on suit colours and boosts' },
  ],
  mechanics: [
    { id: 'scoring', description: 'Each star = 1 point; combo bonus for collecting quickly' },
    { id: 'shop', description: 'Stars buy cosmetic suits and a longer jetpack boost' },
    { id: 'hazards', description: 'Meteors knock the player back; three hits restart the level' },
  ],
  controls: [
    { action: 'move_forward', description: 'Move forward', default_keys: ['W', 'Up'] },
    { action: 'move_back', description: 'Move back', default_keys: ['S', 'Down'] },
    { action: 'move_left', description: 'Move left', default_keys: ['A', 'Left'] },
    { action: 'move_right', description: 'Move right', default_keys: ['D', 'Right'] },
    { action: 'jump', description: 'Jump / boost', default_keys: ['Space'] },
    { action: 'pause', description: 'Pause', default_keys: ['Escape'] },
  ],
  ui: [
    { id: 'hud', purpose: 'Stars, lives, level' },
    { id: 'shop_ui', purpose: 'Shop grid' },
  ],
  audio: [{ id: 'music_space', purpose: 'Calm background music' }],
  win_conditions: ['Finish planet 5'],
  lose_conditions: ['Three meteor hits restarts the level'],
  save_system: { required: true, description: 'Stars, unlocked levels, purchased items' },
  progression: 'Planets unlock in order; shop items unlock with stars.',
  assets: [
    { id: 'kid_astronaut', type: 'character', description: 'Child astronaut, cartoony', required: true },
    { id: 'star', type: 'prop', description: 'Glowing star collectible', required: true },
    { id: 'meteor', type: 'prop', description: 'Low-poly meteor', required: true },
    { id: 'rocket', type: 'prop', description: 'Small rocket (level exit)', required: true },
    { id: 'planet_surface', type: 'environment', description: 'Tiny planet terrain', required: true },
  ],
  dependencies: [],
  performance_targets: { fps: 60, max_memory_mb: 1024 },
  build_profiles: ['QA', 'RELEASE'],
};
