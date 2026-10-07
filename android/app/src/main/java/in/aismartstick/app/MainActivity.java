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
    }
}
