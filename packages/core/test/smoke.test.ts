import { describe, expect, it } from 'vitest';
import * as core from '../src/index';

describe('@kur-river/core 领域内核', () => {
  it('导出 M1 关键能力', () => {
    for (const name of [
      'substituteMacros',
      'scanLorebook',
      'renderMessageForReader',
      'createContextAssembler',
      'allocateBudget',
      'resolveModel',
      'confirmDraft',
      'assertDraftTransition',
      'createInMemoryRepos',
      'createHeuristicTokenCounter',
      'buildOpeningDraftContent',
    ] as const) {
      expect(core[name], name).toBeTypeOf('function');
    }
  });
});
