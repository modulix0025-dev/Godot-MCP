import { defineConfig } from 'vitest/config';

// Core tests spawn real processes (git worktrees, `java -version`, an in-process build worker). On the Windows CI
// runner process start-up alone can exceed vitest's 5 s default, so the suite uses 30 s; live gates set their own.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 } });
