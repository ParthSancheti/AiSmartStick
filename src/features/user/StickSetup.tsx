import { savePairedDevice, type PairedDevice } from '../../core/device/pairedDevice';
import { attachPairedDevice } from '../../core/device/realDevice';
import { currentUid } from '../../core/auth/authStore';
import { useState } from 'react';
import { motion } from 'motion/react';
import { Wifi, ChevronRight, Settings, Check } from 'lucide-react';
import { Glass, GlassButton } from '../../components/glass';
import { AppScreen, SafeAreaContent } from '../../components/Layout';
import { useSession } from '../../core/store/session';

export function StickSetup({ onDone }: { onDone: () => void; onCancel: () => void }) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  return (
    <AppScreen className="z-[90] bg-[#0a0d14]">
      <SafeAreaContent className="px-6 pb-12 pt-6 flex flex-col h-full">
        <div className="flex-1 mt-10">
          <div className="w-16 h-16 rounded-[24px] bg-teal/20 flex items-center justify-center mb-6 border border-teal/30">
            <Wifi size={32} className="text-teal" />
          </div>
          
          <h1 className="text-[28px] font-extrabold leading-[1.1] text-white mb-4 tracking-tight drop-shadow-md">
            Connect to Stick
          </h1>
          <p className="text-[15px] text-white/80 leading-[1.6] mb-10 font-medium drop-shadow-sm">
            Follow these steps to connect your phone to the SmartStick.
          </p>

          <div className="space-y-4">
            <Glass className="rounded-[24px] p-5 border border-white/10 bg-white/5 relative overflow-hidden">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white font-bold shrink-0">1</div>
                <div>
                  <p className="text-[16px] font-bold text-white mb-1">Open Wi-Fi Settings</p>
                  <p className="text-[14px] text-white/60 leading-snug">Go to your phone's settings and turn on Wi-Fi.</p>
                </div>
              </div>
            </Glass>

            <Glass className="rounded-[24px] p-5 border border-white/10 bg-white/5 relative overflow-hidden">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white font-bold shrink-0">2</div>
                <div className="w-full">
                  <p className="text-[16px] font-bold text-white mb-1">Select the network</p>
                  <p className="text-[14px] text-white/60 leading-snug mb-3">Connect to the following Wi-Fi network:</p>
                  <div className="bg-black/30 rounded-lg p-3 border border-white/5 flex items-center justify-between">
                    <span className="font-mono text-teal font-bold tracking-wide">SmartStick_AI</span>
                  </div>
                </div>
              </div>
            </Glass>

            <Glass className="rounded-[24px] p-5 border border-teal/30 bg-teal/10 relative overflow-hidden">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-teal/20 flex items-center justify-center text-teal font-bold shrink-0">3</div>
                <div className="w-full">
                  <p className="text-[16px] font-bold text-white mb-1">Enter Password</p>
                  <p className="text-[14px] text-teal/80 leading-snug mb-3">Use this exact password:</p>
                  <div className="bg-black/40 rounded-lg p-3 border border-teal/20 flex items-center justify-between">
                    <span className="font-mono text-white font-bold tracking-wide">Stick@1234</span>
                  </div>
                </div>
              </div>
            </Glass>
          </div>
        </div>

        <div className="mt-auto pt-6">
          {errorMsg && <p className="text-red-400 text-sm mb-4 text-center">{errorMsg}</p>}
          <GlassButton 
            variant="teal" 
            className="w-full rounded-[24px] h-14 font-bold text-[17px] shadow-[0_0_20px_var(--teal)] border border-teal/50" 
            onClick={async () => {
              setLoading(true);
              setErrorMsg('');
              try {
                const res = await fetch('http://192.168.4.1/api/v1/device', { method: 'GET', signal: AbortSignal.timeout(5000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const info = await res.json();
                if (!info.deviceId || !info.firmware) throw new Error('Invalid device JSON');
                
                const dev: PairedDevice = { 
                  deviceId: info.deviceId, 
                  model: info.model || 'AISS-ESP32CAM-1', 
                  firmware: info.firmware, 
                  protocolVersion: info.protocolVersion || 1, 
                  keyB64: "dummy", 
                  host: "192.168.4.1", 
                  ownerUid: currentUid() || "local", 
                  pairedAt: Date.now() 
                };
                
                await savePairedDevice(dev);
                await attachPairedDevice(dev);
                
                useSession.setState({ userOnboarded: true });
                onDone();
              } catch (e: any) {
                setErrorMsg('Could not reach SmartStick. Make sure you are connected to SmartStick_AI Wi-Fi. (' + e.message + ')');
                setLoading(false);
              }
            }}
            disabled={loading}
          >
            {loading ? 'Connecting...' : "I've Connected"}
          </GlassButton>
        </div>
      </SafeAreaContent>
    </AppScreen>
  );
}
