package com.nyx.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.system.OsConstants;
import android.util.Log;

import io.nekohasekai.libbox.CommandServer;
import io.nekohasekai.libbox.CommandServerHandler;
import io.nekohasekai.libbox.ConnectionOwner;
import io.nekohasekai.libbox.InterfaceUpdateListener;
import io.nekohasekai.libbox.Libbox;
import io.nekohasekai.libbox.LocalDNSTransport;
import io.nekohasekai.libbox.NetworkInterfaceIterator;
import io.nekohasekai.libbox.OverrideOptions;
import io.nekohasekai.libbox.PlatformInterface;
import io.nekohasekai.libbox.RoutePrefix;
import io.nekohasekai.libbox.RoutePrefixIterator;
import io.nekohasekai.libbox.SetupOptions;
import io.nekohasekai.libbox.StringIterator;
import io.nekohasekai.libbox.SystemProxyStatus;
import io.nekohasekai.libbox.TunOptions;
import io.nekohasekai.libbox.WIFIState;

import java.io.File;
import java.net.Inet6Address;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * The VPN: owns the sing-box core (libbox) and the Android TUN device.
 * Structure follows the official sing-box Android client (GPL-3.0).
 */
public class NyxVpnService extends VpnService implements PlatformInterface, CommandServerHandler {
    private static final String TAG = "NyxVpn";
    private static final String CHANNEL_ID = "nyx_vpn";
    private static final int NOTIFICATION_ID = 7701;
    static final String ACTION_START = "com.nyx.mobile.START";
    static final String ACTION_STOP = "com.nyx.mobile.STOP";

    /** What the UI sees. */
    interface Listener {
        void onStatus(String state, String error);
    }

    static volatile String state = "stopped"; // stopped | starting | started | stopping | error
    static volatile String lastError = "";
    static volatile String pendingConfig = null;
    static volatile String pendingName = "Nyx";
    /** Per-app routing for the next start: only these apps use the VPN, or all but these. */
    static volatile List<String> pendingInclude = new ArrayList<>();
    static volatile List<String> pendingExclude = new ArrayList<>();
    static volatile Listener listener = null;
    private static boolean libboxReady = false;

    private CommandServer commandServer;
    private ParcelFileDescriptor tun;
    private ConnectivityManager connectivity;
    private InterfaceUpdateListener interfaceListener;
    private ConnectivityManager.NetworkCallback networkCallback;
    private HandlerThread callbackThread;
    private Network defaultNetwork;

    static void setState(String s, String err) {
        state = s;
        lastError = err == null ? "" : err;
        Listener l = listener;
        if (l != null) l.onStatus(s, lastError);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopVpn();
            return START_NOT_STICKY;
        }
        if (!"starting".equals(state) && !"started".equals(state)) {
            // started by the system without a request (e.g. after a crash): nothing to run
            if (pendingConfig == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        showNotification("Подключение…");
        final String config = pendingConfig;
        pendingConfig = null;
        if (config != null) new Thread(() -> startVpn(config), "nyx-start").start();
        return START_NOT_STICKY;
    }

    // ------------------------------------------------------------------ lifecycle

    private synchronized void startVpn(String config) {
        setState("starting", null);
        try {
            if (!libboxReady) {
                File base = getFilesDir();
                File work = getExternalFilesDir(null);
                if (work == null) work = new File(base, "work");
                work.mkdirs();
                SetupOptions options = new SetupOptions();
                options.setBasePath(base.getPath());
                options.setWorkingPath(work.getPath());
                options.setTempPath(getCacheDir().getPath());
                options.setLogMaxLines(3000);
                options.setFixAndroidStack(Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 29);
                Libbox.setup(options);
                libboxReady = true;
            }
            startNetworkMonitor();
            commandServer = new CommandServer(this, this);
            commandServer.start();
            OverrideOptions override = new OverrideOptions();
            List<String> include = pendingInclude;
            List<String> exclude = pendingExclude;
            if (include != null && !include.isEmpty()) {
                List<String> withSelf = new ArrayList<>(include);
                withSelf.add(getPackageName());
                override.setIncludePackage(new Strings(withSelf.iterator(), withSelf.size()));
            } else if (exclude != null && !exclude.isEmpty()) {
                override.setExcludePackage(new Strings(exclude.iterator(), exclude.size()));
            }
            commandServer.startOrReloadService(config, override);
            setState("started", null);
            showNotification("Подключено");
        } catch (Throwable t) {
            Log.e(TAG, "start failed", t);
            cleanup();
            setState("error", String.valueOf(t.getMessage()));
            stopForegroundCompat();
            stopSelf();
        }
    }

    private synchronized void stopVpn() {
        if ("stopped".equals(state) || "stopping".equals(state)) {
            stopForegroundCompat();
            stopSelf();
            return;
        }
        setState("stopping", null);
        new Thread(() -> {
            cleanup();
            setState("stopped", null);
            stopForegroundCompat();
            stopSelf();
        }, "nyx-stop").start();
    }

    private void cleanup() {
        try {
            if (commandServer != null) {
                try {
                    commandServer.closeService();
                } catch (Throwable t) {
                    Log.w(TAG, "closeService", t);
                }
                commandServer.close();
                commandServer = null;
            }
        } catch (Throwable t) {
            Log.w(TAG, "close", t);
        }
        try {
            if (tun != null) {
                tun.close();
                tun = null;
            }
        } catch (Throwable ignored) {
        }
        stopNetworkMonitor();
    }

    @Override
    public void onDestroy() {
        cleanup();
        if (!"error".equals(state)) setState("stopped", null);
        super.onDestroy();
    }

    @Override
    public void onRevoke() {
        // the user turned the VPN off from the system UI
        stopVpn();
    }

    // ------------------------------------------------------------------ notification

    private void showNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "VPN", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Nyx")
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true);
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    // ------------------------------------------------------------------ default network

    private void startNetworkMonitor() {
        if (networkCallback != null) return;
        callbackThread = new HandlerThread("nyx-network");
        callbackThread.start();
        Handler handler = new Handler(callbackThread.getLooper());
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                defaultNetwork = network;
                reportDefaultInterface(network);
            }

            @Override
            public void onLinkPropertiesChanged(Network network, LinkProperties lp) {
                if (network.equals(defaultNetwork)) reportDefaultInterface(network);
            }

            @Override
            public void onLost(Network network) {
                if (network.equals(defaultNetwork)) {
                    defaultNetwork = null;
                    reportDefaultInterface(null);
                }
            }
        };
        NetworkRequest request = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
                .build();
        // The plain default-network callback would report the VPN itself, so the
        // request forms below ask for the underlying network instead.
        if (Build.VERSION.SDK_INT >= 31) {
            connectivity.registerBestMatchingNetworkCallback(request, networkCallback, handler);
        } else if (Build.VERSION.SDK_INT >= 28) {
            connectivity.requestNetwork(request, networkCallback, handler);
        } else if (Build.VERSION.SDK_INT >= 26) {
            connectivity.registerDefaultNetworkCallback(networkCallback, handler);
        } else {
            connectivity.registerDefaultNetworkCallback(networkCallback);
        }
        if (Build.VERSION.SDK_INT >= 23) defaultNetwork = connectivity.getActiveNetwork();
    }

    private void stopNetworkMonitor() {
        if (networkCallback != null) {
            try {
                connectivity.unregisterNetworkCallback(networkCallback);
            } catch (Throwable ignored) {
            }
            networkCallback = null;
        }
        if (callbackThread != null) {
            callbackThread.quitSafely();
            callbackThread = null;
        }
        defaultNetwork = null;
    }

    private void reportDefaultInterface(Network network) {
        InterfaceUpdateListener l = interfaceListener;
        if (l == null) return;
        if (network == null) {
            l.updateDefaultInterface("", -1, false, false);
            return;
        }
        for (int i = 0; i < 10; i++) {
            LinkProperties lp = connectivity.getLinkProperties(network);
            if (lp == null || lp.getInterfaceName() == null) {
                sleepQuietly(100);
                continue;
            }
            try {
                int index = java.net.NetworkInterface.getByName(lp.getInterfaceName()).getIndex();
                l.updateDefaultInterface(lp.getInterfaceName(), index, false, false);
                return;
            } catch (Exception e) {
                sleepQuietly(100);
            }
        }
    }

    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    // ------------------------------------------------------------------ PlatformInterface

    @Override
    public void autoDetectInterfaceControl(int fd) {
        protect(fd);
    }

    @Override
    public boolean usePlatformAutoDetectInterfaceControl() {
        return true;
    }

    @Override
    public int openTun(TunOptions options) throws Exception {
        if (VpnService.prepare(this) != null) throw new Exception("android: missing vpn permission");
        Builder builder = new Builder().setSession("Nyx").setMtu(options.getMTU());
        if (Build.VERSION.SDK_INT >= 29) builder.setMetered(false);

        RoutePrefixIterator v4 = options.getInet4Address();
        while (v4.hasNext()) {
            RoutePrefix p = v4.next();
            builder.addAddress(p.address(), p.prefix());
        }
        RoutePrefixIterator v6 = options.getInet6Address();
        while (v6.hasNext()) {
            RoutePrefix p = v6.next();
            builder.addAddress(p.address(), p.prefix());
        }

        if (options.getAutoRoute()) {
            if (!Libbox.DNSModeDisabled.equals(options.getDNSMode().getValue())) {
                StringIterator dns = options.getDNSServerAddress();
                while (dns.hasNext()) builder.addDnsServer(dns.next());
            }
            boolean any4 = false, any6 = false;
            RoutePrefixIterator r4 = options.getInet4RouteAddress();
            while (r4.hasNext()) {
                RoutePrefix p = r4.next();
                builder.addRoute(p.address(), p.prefix());
                any4 = true;
            }
            if (!any4) {
                RoutePrefixIterator range4 = options.getInet4RouteRange();
                while (range4.hasNext()) {
                    RoutePrefix p = range4.next();
                    builder.addRoute(p.address(), p.prefix());
                    any4 = true;
                }
            }
            if (!any4 && options.getInet4Address().hasNext()) builder.addRoute("0.0.0.0", 0);
            RoutePrefixIterator r6 = options.getInet6RouteAddress();
            while (r6.hasNext()) {
                RoutePrefix p = r6.next();
                builder.addRoute(p.address(), p.prefix());
                any6 = true;
            }
            if (!any6) {
                RoutePrefixIterator range6 = options.getInet6RouteRange();
                while (range6.hasNext()) {
                    RoutePrefix p = range6.next();
                    builder.addRoute(p.address(), p.prefix());
                    any6 = true;
                }
            }
            if (!any6 && options.getInet6Address().hasNext()) builder.addRoute("::", 0);
            if (Build.VERSION.SDK_INT >= 33) {
                RoutePrefixIterator x4 = options.getInet4RouteExcludeAddress();
                while (x4.hasNext()) {
                    RoutePrefix p = x4.next();
                    builder.excludeRoute(new android.net.IpPrefix(java.net.InetAddress.getByName(p.address()), p.prefix()));
                }
                RoutePrefixIterator x6 = options.getInet6RouteExcludeAddress();
                while (x6.hasNext()) {
                    RoutePrefix p = x6.next();
                    builder.excludeRoute(new android.net.IpPrefix(java.net.InetAddress.getByName(p.address()), p.prefix()));
                }
            }
            StringIterator include = options.getIncludePackage();
            while (include.hasNext()) {
                try {
                    builder.addAllowedApplication(include.next());
                } catch (Exception e) {
                    Log.w(TAG, "addAllowedApplication", e);
                }
            }
            StringIterator exclude = options.getExcludePackage();
            while (exclude.hasNext()) {
                try {
                    builder.addDisallowedApplication(exclude.next());
                } catch (Exception e) {
                    Log.w(TAG, "addDisallowedApplication", e);
                }
            }
        }
        ParcelFileDescriptor pfd = builder.establish();
        if (pfd == null) throw new Exception("android: the application is not prepared or is revoked");
        tun = pfd;
        return pfd.getFd();
    }

    @Override
    public boolean useProcFS() {
        return Build.VERSION.SDK_INT < 29;
    }

    @Override
    public ConnectionOwner findConnectionOwner(int ipProtocol, String sourceAddress, int sourcePort, String destinationAddress, int destinationPort) throws Exception {
        if (Build.VERSION.SDK_INT < 29) throw new Exception("android: unsupported");
        int uid = connectivity.getConnectionOwnerUid(ipProtocol, new InetSocketAddress(sourceAddress, sourcePort), new InetSocketAddress(destinationAddress, destinationPort));
        if (uid == Process.INVALID_UID) throw new Exception("android: connection owner not found");
        String[] packages = getPackageManager().getPackagesForUid(uid);
        ConnectionOwner owner = new ConnectionOwner();
        owner.setUserId(uid);
        owner.setUserName(packages != null && packages.length > 0 ? packages[0] : "");
        List<String> list = new ArrayList<>();
        if (packages != null) Collections.addAll(list, packages);
        owner.setAndroidPackageNames(new Strings(list.iterator(), list.size()));
        return owner;
    }

    @Override
    public void startDefaultInterfaceMonitor(InterfaceUpdateListener l) {
        interfaceListener = l;
        reportDefaultInterface(defaultNetwork);
    }

    @Override
    public void closeDefaultInterfaceMonitor(InterfaceUpdateListener l) {
        interfaceListener = null;
    }

    @Override
    public NetworkInterfaceIterator getInterfaces() throws Exception {
        List<io.nekohasekai.libbox.NetworkInterface> out = new ArrayList<>();
        List<java.net.NetworkInterface> all = Collections.list(java.net.NetworkInterface.getNetworkInterfaces());
        for (Network network : connectivity.getAllNetworks()) {
            LinkProperties lp = connectivity.getLinkProperties(network);
            NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
            if (lp == null || caps == null || lp.getInterfaceName() == null) continue;
            java.net.NetworkInterface ni = null;
            for (java.net.NetworkInterface candidate : all) {
                if (candidate.getName().equals(lp.getInterfaceName())) ni = candidate;
            }
            if (ni == null) continue;
            io.nekohasekai.libbox.NetworkInterface box = new io.nekohasekai.libbox.NetworkInterface();
            box.setName(lp.getInterfaceName());
            box.setIndex(ni.getIndex());
            try {
                box.setMTU(ni.getMTU());
            } catch (Exception ignored) {
            }
            List<String> dns = new ArrayList<>();
            for (java.net.InetAddress a : lp.getDnsServers()) if (a.getHostAddress() != null) dns.add(a.getHostAddress());
            box.setDNSServer(new Strings(dns.iterator(), dns.size()));
            List<String> gateways = new ArrayList<>();
            for (android.net.RouteInfo route : lp.getRoutes()) {
                if (route.getDestination().getPrefixLength() == 0 && route.getGateway() != null && !route.getGateway().isAnyLocalAddress()) {
                    gateways.add(route.getGateway().getHostAddress());
                }
            }
            box.setGateway(new Strings(gateways.iterator(), gateways.size()));
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) box.setType(Libbox.InterfaceTypeWIFI);
            else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) box.setType(Libbox.InterfaceTypeCellular);
            else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) box.setType(Libbox.InterfaceTypeEthernet);
            else box.setType(Libbox.InterfaceTypeOther);
            List<String> addresses = new ArrayList<>();
            for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                String host = ia.getAddress() instanceof Inet6Address
                        ? Inet6Address.getByAddress(ia.getAddress().getAddress()).getHostAddress()
                        : ia.getAddress().getHostAddress();
                addresses.add(host + "/" + ia.getNetworkPrefixLength());
            }
            box.setAddresses(new Strings(addresses.iterator(), addresses.size()));
            int flags = 0;
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) flags = OsConstants.IFF_UP | OsConstants.IFF_RUNNING;
            if (ni.isLoopback()) flags |= OsConstants.IFF_LOOPBACK;
            if (ni.isPointToPoint()) flags |= OsConstants.IFF_POINTOPOINT;
            if (ni.supportsMulticast()) flags |= OsConstants.IFF_MULTICAST;
            box.setFlags(flags);
            box.setMetered(!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
            out.add(box);
        }
        final Iterator<io.nekohasekai.libbox.NetworkInterface> it = out.iterator();
        return new NetworkInterfaceIterator() {
            @Override
            public boolean hasNext() {
                return it.hasNext();
            }

            @Override
            public io.nekohasekai.libbox.NetworkInterface next() {
                return it.next();
            }
        };
    }

    @Override
    public boolean underNetworkExtension() {
        return false;
    }

    @Override
    public boolean includeAllNetworks() {
        return false;
    }

    @Override
    public void clearDNSCache() {
    }

    @Override
    public WIFIState readWIFIState() {
        return null;
    }

    @Override
    public LocalDNSTransport localDNSTransport() {
        return null;
    }

    @Override
    public void registerMyInterface(String name) {
    }

    @Override
    public void sendNotification(io.nekohasekai.libbox.Notification notification) {
    }

    @Override
    public void cancelNotification(String identifier, int typeID) {
    }

    // not used on this platform
    @Override public void checkPlatformShell() throws Exception { throw new Exception("not supported"); }
    @Override public io.nekohasekai.libbox.BridgeSession createBridge(io.nekohasekai.libbox.BridgeOptions o) throws Exception { throw new Exception("not supported"); }
    @Override public String lookupSFTPServer() throws Exception { throw new Exception("not supported"); }
    @Override public io.nekohasekai.libbox.PlatformUser lookupUser(String username) throws Exception { throw new Exception("not supported"); }
    @Override public io.nekohasekai.libbox.ShellSession openShellSession(io.nekohasekai.libbox.PlatformUser u, String c, StringIterator e, String t, int r, int co) throws Exception { throw new Exception("not supported"); }
    @Override public String readSystemSSHHostKey() throws Exception { throw new Exception("not supported"); }
    @Override public void startNeighborMonitor(io.nekohasekai.libbox.NeighborUpdateListener l) throws Exception { }
    @Override public void closeNeighborMonitor(io.nekohasekai.libbox.NeighborUpdateListener l) throws Exception { }
    @Override public String tailscaleHostname() { return "nyx"; }
    @Override public boolean usePlatformBridge() { return false; }
    @Override public boolean usePlatformShell() { return false; }

    // ------------------------------------------------------------------ CommandServerHandler

    @Override public int connectSSHAgent() { return -1; }
    @Override public SystemProxyStatus getSystemProxyStatus() { return null; }
    @Override public void serviceReload() { }
    @Override public void serviceStop() { stopVpn(); }
    @Override public void setSystemProxyEnabled(boolean enabled) { }
    @Override public void triggerNativeCrash() { }
    @Override public void writeDebugMessage(String message) { Log.d("sing-box", String.valueOf(message)); }

    // ------------------------------------------------------------------ helpers

    /** StringIterator over a fixed list. */
    static final class Strings implements StringIterator {
        private final Iterator<String> it;
        private final int size;

        Strings(Iterator<String> it, int size) {
            this.it = it;
            this.size = size;
        }

        @Override public boolean hasNext() { return it.hasNext(); }
        @Override public int len() { return size; }
        @Override public String next() { return it.next(); }
    }
}
