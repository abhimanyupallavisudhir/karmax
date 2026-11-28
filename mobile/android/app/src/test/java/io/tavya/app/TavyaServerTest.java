package io.tavya.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** The device token against a stand-in of tavya's token endpoint: rotation, one refresh at a time, sign-out. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class TavyaServerTest {

    private MockWebServer http;
    private String current = "tvr_grant.0";
    private int issued = 0;
    private boolean revoked = false;
    private final List<String> presented = new ArrayList<>();
    private final List<String> bearers = new ArrayList<>();

    private final class Memory implements TavyaServer.TokenStore {
        String token = current;
        @Override public synchronized String read() { return token; }
        @Override public synchronized void save(String value) { token = value; }
        @Override public synchronized void clear() { token = null; }
    }

    @Before
    public void serve() throws Exception {
        http = new MockWebServer();
        http.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                String path = request.getPath() == null ? "" : request.getPath();
                if (path.equals("/oauth/token")) return token(request.getBody().readUtf8());
                if (path.equals("/api/user/default-organization")) {
                    synchronized (TavyaServerTest.this) { bearers.add(request.getHeader("authorization")); }
                    return json(200, "{\"organizationId\":\"org_1\"}");
                }
                return json(404, "{}");
            }
        });
        http.start();
    }

    private synchronized MockResponse token(String form) {
        String token;
        try { token = java.net.URLDecoder.decode(form.replaceAll(".*refresh_token=([^&]*).*", "$1"), "UTF-8"); }
        catch (java.io.UnsupportedEncodingException e) { throw new AssertionError(e); }
        presented.add(token);
        if (!form.contains("client_id=tavya-app") || !form.contains("grant_type=refresh_token")) return json(400, "{\"error\":\"invalid_request\"}");
        // A rotated token presented again revokes the grant (src/auth/app-grants.ts).
        if (revoked || !token.equals(current)) { revoked = true; return json(400, "{\"error\":\"invalid_grant\"}"); }
        current = "tvr_grant." + (++issued);
        // Slow enough that callers pile up behind one refresh.
        try { Thread.sleep(50); } catch (InterruptedException ignored) {}
        return json(200, "{\"access_token\":\"tva_" + issued + "\",\"refresh_token\":\"" + current + "\",\"expires_in\":3600,\"scope\":\"all\"}");
    }

    private static MockResponse json(int status, String body) {
        return new MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body);
    }

    @After
    public void stop() throws Exception { http.shutdown(); }

    private String origin() { return "http://127.0.0.1:" + http.getPort(); }

    @Test
    public void rotatesTheTokenAndKeepsTheNewOneBeforeUsingIt() throws Exception {
        Memory store = new Memory();
        TavyaServer server = new TavyaServer(origin() + "/", store);
        assertEquals("org_1", server.get("/api/user/default-organization").getString("organizationId"));
        assertEquals("tvr_grant.1", store.token);
        assertEquals(List.of("Bearer tva_1"), bearers);
        // The access token is reused while it lives: no second refresh.
        server.get("/api/user/default-organization");
        assertEquals(List.of("tvr_grant.0"), presented);
    }

    @Test
    public void manyCallersAtOnceRefreshOnceSoNoRotatedTokenIsEverPresented() throws Exception {
        Memory store = new Memory();
        TavyaServer server = new TavyaServer(origin(), store);
        ExecutorService callers = Executors.newFixedThreadPool(6);
        CountDownLatch done = new CountDownLatch(12);
        for (int i = 0; i < 12; i++) {
            callers.execute(() -> {
                try { server.get("/api/user/default-organization"); } catch (Exception e) { fail(e.toString()); } finally { done.countDown(); }
            });
        }
        assertTrue(done.await(20, TimeUnit.SECONDS));
        assertEquals(1, presented.size());
        assertTrue(!revoked);
        // Forgetting the access token (a new sign-in) refreshes once more, with the token kept last.
        server.forget();
        server.get("/api/user/default-organization");
        assertEquals(List.of("tvr_grant.0", "tvr_grant.1"), presented);
        assertEquals("tvr_grant.2", store.token);
    }

    @Test
    public void aTokenTheServerRefusesSignsThePhoneOut() throws Exception {
        Memory store = new Memory();
        store.token = "tvr_grant.stale";
        TavyaServer server = new TavyaServer(origin(), store);
        try {
            server.get("/api/user/default-organization");
            fail("expected SignedOut");
        } catch (TavyaServer.SignedOut expected) {
            assertNull(store.token);
        }
        try {
            server.accessToken();
            fail("expected SignedOut");
        } catch (TavyaServer.SignedOut expected) {
            assertEquals(1, presented.size());
        }
    }
}
