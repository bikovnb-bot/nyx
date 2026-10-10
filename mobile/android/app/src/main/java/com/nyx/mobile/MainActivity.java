package com.nyx.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NyxVpnPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
