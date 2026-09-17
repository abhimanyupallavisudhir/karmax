import { expect, it } from 'vitest';
import { MANIFESTS } from '../src/contrib/manifests.js';
import { bundledStart } from '../src/platform/resolve-start.js';
import { WORKFLOW_TYPE } from '../src/workflows/names.js';

// Exercise the same default resolution used by API creation and trigger arming.
// A worker export alone does not make a new manifest version startable.
it.each(MANIFESTS.filter(manifest => WORKFLOW_TYPE[manifest.name]))(
  'resolves the current $name manifest through the API start registry', (manifest) => {
    expect(bundledStart(manifest.name)).toEqual({
      startType: `${WORKFLOW_TYPE[manifest.name]}@${manifest.version}`, manifest,
    });
  },
);
