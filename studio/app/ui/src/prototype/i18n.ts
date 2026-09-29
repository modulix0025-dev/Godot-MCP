// SPDX-License-Identifier: Apache-2.0
//
// Prototype strings. English and Arabic are first-class: every chrome string has both. Owner content
// (chat, briefs, names) stays in whatever language the owner typed and is rendered with `dir="auto"` /
// `unicode-bidi: plaintext`, so mixed Arabic/English text lays out correctly in either UI direction.

export type Lang = 'en' | 'ar';

const en = {
  appName: 'ModuleX Game Studio',
  nav: {
    projects: 'Projects',
    studio: 'Studio',
    activity: 'Activity',
    assets: 'Assets',
    test: 'Test & Debug',
    builds: 'Builds',
    workers: 'Workers',
    approvals: 'Approvals',
    settings: 'Settings',
  },
  health: { agent: 'Agent', godot: 'Godot 4.5.1', mcp: 'MCP', gpu: '2 GPU' },
  budget: 'Budget',
  search: 'Search or run a command…',
  newGame: 'New game',
  import: 'Import',
  recentActivity: 'Recent activity',
  system: 'System',
  conversation: 'Conversation',
  preview: 'Preview',
  pipeline: 'Pipeline',
  describe: 'Describe a change…',
  send: 'Send',
  pauseAgent: 'Pause agent',
  build: 'Build',
  approve: 'Approve',
  edit: 'Edit',
  reject: 'Reject',
  alwaysAllow: 'Always allow for this project',
  context: 'Context',
  generate: 'Generate',
  retryStage: 'Retry stage',
  replace: 'Replace',
  run: 'Run',
  buildGame: 'Build game',
  addWorker: 'Add worker',
  test: 'Test',
  copyDiagnostics: 'Copy diagnostics',
  openInGodot: 'Open in Godot',
  states: {
    empty: 'Empty',
    loading: 'Loading',
    error: 'Error',
    blocked: 'Blocked',
    normal: 'Normal',
  },
} as const;

type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };
export type Strings = Shape<typeof en>;

const ar: Strings = {
  appName: 'استوديو ModuleX للألعاب',
  nav: {
    projects: 'المشاريع',
    studio: 'الاستوديو',
    activity: 'النشاط',
    assets: 'الأصول',
    test: 'الاختبار والتصحيح',
    builds: 'الإصدارات',
    workers: 'العُمّال',
    approvals: 'الموافقات',
    settings: 'الإعدادات',
  },
  health: { agent: 'الوكيل', godot: 'Godot 4.5.1', mcp: 'MCP', gpu: '2 GPU' },
  budget: 'الميزانية',
  search: 'ابحث أو نفّذ أمرًا…',
  newGame: 'لعبة جديدة',
  import: 'استيراد',
  recentActivity: 'آخر النشاطات',
  system: 'النظام',
  conversation: 'المحادثة',
  preview: 'المعاينة',
  pipeline: 'مراحل العمل',
  describe: 'صف التغيير المطلوب…',
  send: 'إرسال',
  pauseAgent: 'إيقاف الوكيل مؤقتًا',
  build: 'بناء',
  approve: 'موافقة',
  edit: 'تعديل',
  reject: 'رفض',
  alwaysAllow: 'السماح دائمًا لهذا المشروع',
  context: 'السياق',
  generate: 'توليد',
  retryStage: 'إعادة المرحلة',
  replace: 'استبدال',
  run: 'تشغيل',
  buildGame: 'بناء اللعبة',
  addWorker: 'إضافة عامل',
  test: 'اختبار',
  copyDiagnostics: 'نسخ التشخيص',
  openInGodot: 'فتح في Godot',
  states: {
    empty: 'فارغ',
    loading: 'تحميل',
    error: 'خطأ',
    blocked: 'محظور',
    normal: 'عادي',
  },
};

export const STRINGS: Record<Lang, Strings> = { en, ar };
