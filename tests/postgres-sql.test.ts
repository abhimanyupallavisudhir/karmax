import { describe, expect, it } from 'vitest';
import { translate } from '../src/store/postgres-sql.mjs';

describe('PostgreSQL SQL translation', () => {
  it('compares JSON booleans without casting true to an integer', () => {
    const sql = translate("SELECT id FROM tasks WHERE COALESCE(json_extract(params, '$.draft'), 0) = 0").sql;
    expect(sql).not.toContain('::integer');
    expect(sql).toContain("'false'");
  });

  it('removes any number of JSON paths including nested paths', () => {
    const one = translate("SELECT json_remove(lastView, '$.messages') FROM tasks").sql;
    const four = translate("SELECT json_remove(lastView, '$.messages', '$.transcripts', '$.reviewInfo', '$.state.debug') FROM tasks").sql;
    expect(one).not.toContain('json_remove');
    expect(four).not.toContain('json_remove');
    expect(four).toContain("#- '{state,debug}'");
  });
});
