package com.nyx.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The bridge between the web UI and the VPN service. */
@CapacitorPlugin(name = "NyxVpn")
public class NyxVpnPlugin extends Plugin {

    @Override
    public void load() {
        NyxVpnService.listener = (state, error) -> {
            JSObject data = new JSObject();
            data.put("state", state);
            data.put("error", error);
            notifyListeners("status", data);
        };
    }

    @Override
    protected void handleOnDestroy() {
        NyxVpnService.listener = null;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject res = new JSObject();
        res.put("state", NyxVpnService.state);
        res.put("error", NyxVpnService.lastError);
        call.resolve(res);
    }

    /** Starts the tunnel with a ready sing-box config, asking for the VPN permission first. */
    @PluginMethod
    public void start(PluginCall call) {
        String config = call.getString("config");
        if (config == null || config.isEmpty()) {
            call.reject("config is empty");
            return;
        }
        NyxVpnService.pendingConfig = config;
        NyxVpnService.pendingInclude = toList(call.getArray("includePackages"));
        NyxVpnService.pendingExclude = toList(call.getArray("excludePackages"));
        Intent prepare = VpnService.prepare(getContext());
        if (prepare != null) {
            startActivityForResult(call, prepare, "vpnPermissionResult");
        } else {
            launch(call);
        }
    }

    @ActivityCallback
    private void vpnPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_OK) {
            launch(call);
        } else {
            NyxVpnService.pendingConfig = null;
            call.reject("vpn permission denied");
        }
    }

    private void launch(PluginCall call) {
        Intent intent = new Intent(getContext(), NyxVpnService.class).setAction(NyxVpnService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent);
        else getContext().startService(intent);
        call.resolve();
    }

    private static java.util.List<String> toList(JSArray array) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            String s = array.optString(i, "");
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    /** Copies the routing lists shipped with the app to a folder the core can read. */
    @PluginMethod
    public void prepareRules(PluginCall call) {
        try {
            java.io.File dir = new java.io.File(getContext().getFilesDir(), "rules");
            dir.mkdirs();
            String[] names = getContext().getAssets().list("public/rules");
            if (names != null) {
                for (String name : names) {
                    java.io.File target = new java.io.File(dir, name);
                    // a list refreshed by the user (newer than the packaged one) stays
                    if (target.exists()) continue;
                    try (java.io.InputStream in = getContext().getAssets().open("public/rules/" + name);
                         java.io.FileOutputStream out = new java.io.FileOutputStream(target)) {
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                }
            }
            JSObject res = new JSObject();
            res.put("dir", dir.getAbsolutePath());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("rules: " + e.getMessage());
        }
    }

    /** Apps with a launcher icon, for the per-app routing picker. */
    @PluginMethod
    public void listApps(PluginCall call) {
        android.content.pm.PackageManager pm = getContext().getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        JSArray apps = new JSArray();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (android.content.pm.ResolveInfo ri : pm.queryIntentActivities(main, 0)) {
            String pkg = ri.activityInfo.packageName;
            if (pkg.equals(getContext().getPackageName()) || !seen.add(pkg)) continue;
            JSObject app = new JSObject();
            app.put("package", pkg);
            app.put("label", String.valueOf(ri.loadLabel(pm)));
            apps.put(app);
        }
        JSObject res = new JSObject();
        res.put("apps", apps);
        call.resolve(res);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), NyxVpnService.class).setAction(NyxVpnService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }
}
