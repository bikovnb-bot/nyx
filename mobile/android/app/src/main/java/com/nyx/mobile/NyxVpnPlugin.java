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
        String name = call.getString("name");
        NyxVpnService.pendingName = name == null ? "Nyx" : name;
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

    /** TCP connect time to each server, measured outside the tunnel, for auto-select. */
    @PluginMethod
    public void pingServers(PluginCall call) {
        final JSArray targets = call.getArray("targets");
        new Thread(() -> {
            JSArray out = new JSArray();
            try {
                java.util.List<Thread> threads = new java.util.ArrayList<>();
                final java.util.concurrent.ConcurrentHashMap<String, Long> results = new java.util.concurrent.ConcurrentHashMap<>();
                final java.util.List<String> ids = new java.util.ArrayList<>();
                for (int i = 0; targets != null && i < targets.length(); i++) {
                    org.json.JSONObject t = targets.getJSONObject(i);
                    final String id = t.getString("id");
                    final String host = t.getString("host");
                    final int port = t.getInt("port");
                    ids.add(id);
                    Thread th = new Thread(() -> {
                        long t0 = System.nanoTime();
                        try (java.net.Socket s = new java.net.Socket()) {
                            s.connect(new java.net.InetSocketAddress(host, port), 3000);
                            results.put(id, (System.nanoTime() - t0) / 1_000_000);
                        } catch (Exception ignored) {
                        }
                    });
                    th.start();
                    threads.add(th);
                }
                for (Thread th : threads) th.join(3500);
                for (String id : ids) {
                    JSObject r = new JSObject();
                    r.put("id", id);
                    Long ms = results.get(id);
                    r.put("ms", ms == null ? org.json.JSONObject.NULL : ms);
                    out.put(r);
                }
            } catch (Exception ignored) {
            }
            JSObject res = new JSObject();
            res.put("results", out);
            call.resolve(res);
        }, "nyx-ping").start();
    }

    /** A small PNG (data URL) of an installed app's icon, for the app picker. */
    @PluginMethod
    public void appIcon(PluginCall call) {
        String pkg = call.getString("package");
        try {
            android.graphics.drawable.Drawable d = getContext().getPackageManager().getApplicationIcon(pkg);
            android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(64, 64, android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas c = new android.graphics.Canvas(bmp);
            d.setBounds(0, 0, 64, 64);
            d.draw(c);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, bos);
            JSObject res = new JSObject();
            res.put("icon", "data:image/png;base64," + android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("no icon");
        }
    }

    /** Is the app exempt from battery optimisation (needed to survive in the background)? */
    @PluginMethod
    public void batteryStatus(PluginCall call) {
        android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        JSObject res = new JSObject();
        res.put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        res.put("manufacturer", Build.MANUFACTURER);
        call.resolve(res);
    }

    /** Asks the system to stop restricting the app's background work. */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("unavailable");
        }
    }

    /** Opens the maker's auto-start screen (Xiaomi and a few others) or the app's system page. */
    @PluginMethod
    public void openAutostart(PluginCall call) {
        String[][] known = {
                {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
        };
        for (String[] k : known) {
            try {
                Intent i = new Intent().setClassName(k[0], k[1]).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
                return;
            } catch (Exception ignored) {
            }
        }
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("unavailable");
        }
    }

    /** Version of the installed app, and whether it may install APK files. */
    @PluginMethod
    public void appInfo(PluginCall call) {
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject res = new JSObject();
            res.put("versionName", pi.versionName);
            res.put("versionCode", Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
            res.put("canInstall", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("no info");
        }
    }

    /** Downloads an update to the cache folder, checks its SHA-256 and reports progress. */
    @PluginMethod
    public void downloadApk(PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://127.0.0.1")) || sha256 == null) {
            call.reject("bad request");
            return;
        }
        new Thread(() -> {
            java.io.File dir = new java.io.File(getContext().getCacheDir(), "updates");
            dir.mkdirs();
            java.io.File[] old = dir.listFiles();
            if (old != null) for (java.io.File f : old) f.delete();
            java.io.File out = new java.io.File(dir, "nyx-update.apk");
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                long total = c.getContentLengthLong();
                java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
                long got = 0, lastReport = 0;
                try (java.io.InputStream in = c.getInputStream(); java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                        md.update(buf, 0, n);
                        got += n;
                        if (got - lastReport > 512 * 1024) {
                            lastReport = got;
                            JSObject p = new JSObject();
                            p.put("got", got);
                            p.put("total", total);
                            notifyListeners("download", p);
                        }
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest()) hex.append(String.format("%02x", b));
                if (!hex.toString().equalsIgnoreCase(sha256.trim())) {
                    out.delete();
                    throw new Exception("checksum mismatch");
                }
                JSObject res = new JSObject();
                res.put("path", out.getAbsolutePath());
                call.resolve(res);
            } catch (Exception e) {
                out.delete();
                call.reject(String.valueOf(e.getMessage()));
            }
        }, "nyx-download").start();
    }

    /** Hands a downloaded APK to the system installer. */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        android.net.Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
                call.reject("permission");
                return;
            }
            java.io.File apk = new java.io.File(path);
            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), NyxVpnService.class).setAction(NyxVpnService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }
}
