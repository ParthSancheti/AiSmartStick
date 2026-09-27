/** Ambient Animated Background using highly blurred circles */
export function Atmosphere({ variant = 'user' }: { variant?: 'guardian' | 'user' | 'calm' }) {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0 transition-colors duration-300">
      <div
        className="absolute -top-[10%] -left-[20%] w-[80%] aspect-square rounded-full bg-gradient-to-tr from-teal to-teal blur-[120px] opacity-40 dark:opacity-30 mix-blend-multiply dark:mix-blend-screen"
        style={{ animation: 'drift 26s ease-in-out infinite alternate' }}
      />
      <div
        className="absolute top-[10%] left-[45%] w-[70%] aspect-square rounded-full bg-gradient-to-tr from-info to-mint blur-[130px] opacity-40 dark:opacity-20 mix-blend-multiply dark:mix-blend-screen"
        style={{ animation: 'drift 31s ease-in-out infinite alternate -6s' }}
      />
      <div
        className="absolute top-[55%] -left-[10%] w-[75%] aspect-square rounded-full bg-gradient-to-tr from-info to-teal blur-[140px] opacity-40 dark:opacity-30 mix-blend-multiply dark:mix-blend-screen"
        style={{ animation: 'drift 37s ease-in-out infinite alternate -12s' }}
      />
    </div>
  );
}
