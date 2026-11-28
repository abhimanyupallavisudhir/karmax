package io.tavya.app;

/**
 * Verified links (Android App Links) into the console. assetlinks.json can only
 * verify a whole host, so the paths that are not the console's — the public
 * site, the API, sign-in, downloads — are left to the browser: the manifest's
 * uri-relative-filter-group excludes them on Android 15+, and LinkActivity
 * sends them back to the browser on older versions.
 *
 * The same list as APP_LINK_EXCLUDED_PATHS in src/platform/app-links.ts (the
 * iOS apple-app-site-association); tests/phone-app-links.test.ts keeps the
 * two, and the manifest, in step.
 */
final class AppLinks {

    static final String[] EXCLUDED_PATHS = { "/", "/docs*", "/pricing*", "/legal*", "/compare*", "/about*", "/changelog*",
        "/api/*", "/oauth/*", "/.well-known/*", "/device*", "/share/*", "/git/*", "/download/*", "/mcp*", "/ws*", "/link/*" };

    private AppLinks() {}

    /** True when `path` is not a console page and belongs in the browser. */
    static boolean isExcluded(String path) {
        String p = path == null || path.isEmpty() ? "/" : path;
        for (String pattern : EXCLUDED_PATHS) {
            if (pattern.endsWith("*") ? p.startsWith(pattern.substring(0, pattern.length() - 1)) : p.equals(pattern)) return true;
        }
        return false;
    }
}
