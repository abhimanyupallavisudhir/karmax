package io.tavya.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AppLinksTest {

    @Test
    public void consolePagesOpenInTheApp() {
        assertFalse(AppLinks.isExcluded("/acme/website/tasks/12"));
        assertFalse(AppLinks.isExcluded("/acme"));
        assertFalse(AppLinks.isExcluded("/profile"));
        // A trailing * is a prefix, not a folder: /docsite would be excluded, /a/docs is not.
        assertFalse(AppLinks.isExcluded("/acme/docs"));
    }

    @Test
    public void theSiteTheApiAndSignInStayInTheBrowser() {
        for (String path : new String[] { "/", "", null, "/docs", "/docs/apps", "/pricing", "/legal/privacy", "/api/tasks",
                "/oauth/authorize", "/.well-known/assetlinks.json", "/device", "/share/files/x", "/git/x.git", "/download/mac",
                "/mcp", "/ws", "/link/chat" }) {
            assertTrue(String.valueOf(path), AppLinks.isExcluded(path));
        }
        // "/api/*" is the folder only: a project called "api-docs" opens in the app.
        assertFalse(AppLinks.isExcluded("/api-docs"));
    }
}
