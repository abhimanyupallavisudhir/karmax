export function parseVersion(version: string): number[];
export function compareVersions(a: string, b: string): number;
export function nextCliVersion(input: { floor: string; released: string[]; shippedChanged: boolean }): { version: string; release: boolean };
export function writeCliVersion(root: string, version: string): void;
