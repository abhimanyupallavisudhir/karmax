import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import base from '../../../vitest.config.js';

// The suite's own process model (one process, shared module graph) and setup
// files, over three files that must run in the order their names give.
class ByName extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
  }
}

export default defineConfig({
  root: import.meta.dirname,
  test: {
    ...base.test,
    include: ['*.fixture.ts'],
    setupFiles: (base.test!.setupFiles as string[]).map((file) => new URL(`../../../${file}`, import.meta.url).pathname),
    sequence: { sequencer: ByName },
  },
});
