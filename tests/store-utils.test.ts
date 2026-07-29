import { describe, it, expect } from 'vitest';
import { S3ObjectStore } from '../src/store/objects.js';
import { stripJsonComments, parseDevcontainer } from '../src/store/project-environment.js';

describe('S3 SigV4 canonical URI', () => {
  it('percent-encodes the RFC3986 sub-delims encodeURIComponent leaves alone', async () => {
    // `encodeURIComponent` leaves !'()* literal (RFC 2396 "marks"). SigV4 signs
    // the fully-encoded path, so a key containing any of them was signed one way
    // and sent another → SignatureDoesNotMatch.
    let requested: URL | undefined;
    const store = new S3ObjectStore({ endpoint: 'https://s3.example.com', bucket: 'buck', region: 'us-east-1',
      accessKeyId: 'AKIA', secretAccessKey: 'secret',
      fetch: (async (input: any) => { requested = new URL(String(input)); return new Response('ok'); }) as typeof fetch });

    await store.get("checkpoints/it's (a) test!*");
    expect(requested!.pathname).toBe('/buck/checkpoints/it%27s%20%28a%29%20test%21%2A');
    for (const ch of ["!", "'", '(', ')', '*']) expect(requested!.pathname).not.toContain(ch);
  });

  it('still encodes the ordinary path characters and keeps unreserved ones literal', async () => {
    let requested: URL | undefined;
    const store = new S3ObjectStore({ endpoint: 'https://s3.example.com', bucket: 'b', region: 'r',
      accessKeyId: 'A', secretAccessKey: 's',
      fetch: (async (input: any) => { requested = new URL(String(input)); return new Response('ok'); }) as typeof fetch });
    await store.get('a-b_c.d~e/f');
    expect(requested!.pathname).toBe('/b/a-b_c.d~e/f'); // unreserved set survives; `/` stays a separator
  });
});

describe('devcontainer JSONC parsing', () => {
  it('strips trailing commas only outside strings', () => {
    // The old whole-document regex could not see string boundaries, so it deleted
    // characters out of the middle of a perfectly ordinary command string.
    const text = `{
      // a comment
      "image": "node:22",
      "postCreateCommand": "npm i --workspaces, [dev]",
      "onCreateCommand": ["echo", "x, ]"],
    }`;
    const json = stripJsonComments(text);
    expect(() => JSON.parse(json)).not.toThrow();
    const doc = JSON.parse(json);
    expect(doc.postCreateCommand).toBe('npm i --workspaces, [dev]');
    expect(doc.onCreateCommand).toEqual(['echo', 'x, ]']);
    // (a string command passes through verbatim; an array form is shell-quoted)
    expect(parseDevcontainer(text).setup).toEqual([`echo 'x, ]'`, 'npm i --workspaces, [dev]']);
  });

  it('still removes genuine trailing commas and comments', () => {
    expect(JSON.parse(stripJsonComments('{ "a": [1, 2, ], /* c */ "b": 3, }'))).toEqual({ a: [1, 2], b: 3 });
    expect(JSON.parse(stripJsonComments('{ "u": "https://x/y", // trailing\n "v": 1 }'))).toEqual({ u: 'https://x/y', v: 1 });
    // An escaped quote must not end the string early.
    expect(JSON.parse(stripJsonComments('{ "a": "say \\", ]" }'))).toEqual({ a: 'say ", ]' });
  });
});
