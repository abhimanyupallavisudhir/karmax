package io.tavya.app;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import android.widget.TextView;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** The widget shows what the console last told it, or Sign in. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ForMeWidgetTest {

    private final Context context = ApplicationProvider.getApplicationContext();

    private String count() {
        RemoteViews views = ForMeWidget.views(context);
        View shown = views.apply(context, new FrameLayout(context));
        return ((TextView) shown.findViewById(R.id.widget_count)).getText().toString();
    }

    @Test
    public void showsTheCountTheConsoleSet() {
        PhoneState.setContext(context, "org_1", 3);
        assertEquals("3", count());
        assertEquals("org_1", PhoneState.organizationId(context));
        PhoneState.setContext(context, "org_1", 250);
        assertEquals("99+", count());
    }

    @Test
    public void signedOutItSaysSignIn() {
        PhoneState.setContext(context, null, 0);
        assertEquals("Sign in", count());
    }
}
