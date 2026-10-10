package com.nyx.mobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;

/**
 * Brings the VPN back after the system has killed the app (memory clean-up, "clear
 * all" on some firmwares). While a session is saved, a repeating alarm checks that
 * the service is alive; alarms survive the death of the process, a sticky restart
 * often does not.
 */
public class NyxWatchdog extends BroadcastReceiver {
    private static final String TAG = "NyxWatchdog";
    static final String ACTION_CHECK = "com.nyx.mobile.WATCHDOG";
    private static final long INTERVAL_MS = 60_000L;

    static File sessionFile(Context c) {
        return new File(c.getFilesDir(), "vpn_session.json");
    }

    private static PendingIntent pending(Context c) {
        Intent i = new Intent(c, NyxWatchdog.class).setAction(ACTION_CHECK);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void schedule(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long at = SystemClock.elapsedRealtime() + INTERVAL_MS;
        try {
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending(c));
            } else {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending(c));
            }
        } catch (Exception e) {
            Log.w(TAG, "schedule", e);
        }
    }

    static void cancel(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(c));
    }

    static void startService(Context c) {
        Intent i = new Intent(c, NyxVpnService.class).setAction(NyxVpnService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!sessionFile(context).exists()) return; // the user switched the VPN off
        String s = NyxVpnService.state;
        if (!"started".equals(s) && !"starting".equals(s)) {
            Log.i(TAG, "VPN is not running but a session is saved: restoring");
            try {
                startService(context);
            } catch (Exception e) {
                Log.w(TAG, "restore failed", e);
            }
        }
        schedule(context);
    }
}
