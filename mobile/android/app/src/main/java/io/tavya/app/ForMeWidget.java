package io.tavya.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/**
 * The home-screen widget: the For-me count (tap → For me) and a mic (tap → Ask,
 * already listening). Repainted from PhoneState whenever it changes; the
 * system's periodic update (every 30 min at most) also reads the count from
 * the server.
 */
public class ForMeWidget extends AppWidgetProvider {

    static final String FOR_ME = "io.tavya.app://for-me";
    static final String ASK_BY_VOICE = "io.tavya.app://ask?voice=1";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        paint(context, manager, ids);
        PendingResult pending = goAsync();
        PhoneState.refreshSoon(context, pending::finish);
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        if (manager == null) return;
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, ForMeWidget.class));
        if (ids.length > 0) paint(context, manager, ids);
    }

    private static void paint(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, views(context));
    }

    static RemoteViews views(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_for_me);
        int count = PhoneState.forMe(context);
        boolean signedOut = PhoneState.signedOut(context);
        views.setTextViewText(R.id.widget_count, signedOut ? context.getString(R.string.widget_sign_in)
            : count == PhoneState.UNKNOWN ? "–" : count > 99 ? "99+" : String.valueOf(count));
        views.setTextViewText(R.id.widget_label, context.getString(R.string.widget_for_me));
        views.setContentDescription(R.id.widget_for_me, signedOut ? context.getString(R.string.widget_sign_in)
            : context.getResources().getQuantityString(R.plurals.widget_for_me_count, Math.max(0, count), Math.max(0, count)));
        views.setOnClickPendingIntent(R.id.widget_for_me, link(context, FOR_ME, 1));
        views.setOnClickPendingIntent(R.id.widget_mic, link(context, ASK_BY_VOICE, 2));
        return views;
    }

    /** Opens the app at `link` (handed to the console as an io.tavya.app:// link). */
    static PendingIntent link(Context context, String link, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
