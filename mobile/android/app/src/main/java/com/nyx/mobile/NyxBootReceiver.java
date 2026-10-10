package com.nyx.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** After a reboot, bring the VPN back if it was on when the phone went down. */
public class NyxBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (!NyxWatchdog.sessionFile(context).exists()) return;
        try {
            NyxWatchdog.startService(context);
            NyxWatchdog.schedule(context);
        } catch (Exception e) {
            Log.w("NyxBoot", "restore after boot failed", e);
        }
    }
}
