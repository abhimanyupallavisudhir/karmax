#!/usr/bin/env node
// The tavya CLI from this checkout (src/cli). The published package bundles the
// same source into one file (scripts/build-cli.mjs).
import { register } from 'tsx/esm/api';

register();
await import('../src/cli/bin.ts');
