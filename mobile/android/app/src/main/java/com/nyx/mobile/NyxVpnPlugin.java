package com.nyx.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;

import androidx.activity.result.ActivityResult;

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

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), NyxVpnService.class).setAction(NyxVpnService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }
}
