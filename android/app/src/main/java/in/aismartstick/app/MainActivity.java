package in.aismartstick.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

import androidx.core.view.WindowCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        registerPlugin(AissNativePlugin.class);
        // Phone GPS via android.location.LocationManager (no Google Play Services needed).
        registerPlugin(AissLocationPlugin.class);
        super.onCreate(savedInstanceState);
        // Android's font-size setting would enlarge WebView text inside fixed-size cards and cut them
        // off on the right. Pin the WebView to 100 %; the app applies its own tested text size instead
        // (seeded from the system font scale on first launch, see src/core/native/textScale.ts).
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().getSettings().setTextZoom(100);
            }
        } catch (Exception ignored) {
        }
    }
}
