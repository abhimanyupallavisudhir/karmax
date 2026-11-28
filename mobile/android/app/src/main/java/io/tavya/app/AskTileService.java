package io.tavya.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** The Quick Settings tile "Ask tavya": opens Ask, already listening. */
public class AskTileService extends TileService {

    @Override
    public void onStartListening() {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setState(Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @Override
    public void onClick() {
        if (isLocked()) unlockAndRun(this::openAsk);
        else openAsk();
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    @SuppressWarnings("deprecation")
    private void openAsk() {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(ForMeWidget.ASK_BY_VOICE), this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // Android 14 takes only a PendingIntent here.
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(ForMeWidget.link(this, ForMeWidget.ASK_BY_VOICE, 3));
        else startActivityAndCollapse(intent);
    }
}
