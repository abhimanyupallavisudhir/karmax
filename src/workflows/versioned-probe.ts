import { defineSignal, setHandler, condition } from '@temporalio/workflow';

/**
 * A tiny two-version workflow used to prove the version-pinning mechanism
 * (PLAN-dynamic-repos §21b): two code versions register under distinct
 * `type@version` names in one worker, each execution pins to the version it was
 * started with, and an in-flight execution keeps its pinned code even after a
 * newer version is registered. It carries no business logic — it only reports
 * which code version ran, and blocks on a signal so a test can hold one
 * execution open while starting another.
 *
 * These are inert in production: nothing starts them except the determinism
 * test, exactly like `ping`.
 */
export const release = defineSignal('release');

export async function versionedProbeV1(): Promise<{ version: string }> {
  let go = false;
  setHandler(release, () => {
    go = true;
  });
  await condition(() => go);
  return { version: '1.0.0' };
}

export async function versionedProbeV2(): Promise<{ version: string }> {
  let go = false;
  setHandler(release, () => {
    go = true;
  });
  await condition(() => go);
  return { version: '2.0.0' };
}
