Bug report from a user of tiny-semver:

> We use `maxSatisfying` to pick dependency versions, and `^0.2.3` picked `0.9.1`, which broke our build. npm would never install 0.9.1 for `^0.2.3`. I think caret ranges on 0.x versions are wrong in general — please make them behave like npm's.

Please fix it and add tests.
