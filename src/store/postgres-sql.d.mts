export function splitStatements(sql: string): string[];
export function translate(statement: string): { skip?: boolean; sql?: string; forcedParams?: unknown[] };
