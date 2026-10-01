/** The legacy whole-document checkpoint (KMX1, gzip, version 1). Nothing
 * writes it any more; restore still reads it until such checkpoints age out.
 * `symlink` entries carry the link's exact target as `data` (WD-33). */
export interface DeltaFile { repo: string; path: string; deleted?: boolean; symlink?: boolean; data?: string }
export interface PortableDelta { version: 1; files: DeltaFile[] }
