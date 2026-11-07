# tiny-semver

Small, dependency-free semver version parsing and npm-style range matching.

```js
import { satisfies, maxSatisfying } from 'tiny-semver';
satisfies('1.4.2', '^1.2.3'); // true
```

Run the tests with `npm test`.
