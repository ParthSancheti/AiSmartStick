import type { ReactNode } from 'react';

/** Device bezel for the side-by-side demo stage. `--island` tells apps how much room the camera cut-out needs. */
export function PhoneFrame({ label, sub, children }: { label: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-3" style={{ zoom: 'min(1, calc((100dvh - 100px) / 866))' } as any}>
      <div
        className="relative rounded-[58px] bg-[#0e1b20] p-[11px]"
        style={{
          width: '412px',
          height: '866px',
          boxShadow: '0 50px 90px -40px rgba(8,40,44,.55), inset 0 0 0 1.5px rgba(255,255,255,.14), 0 0 0 1px rgba(0,0,0,.4)',
        }}
      >
        <div
          className="relative h-full w-full overflow-hidden rounded-[47px] bg-bg"
          style={{ transform: 'translateZ(0)', ['--island' as string]: '46px' }}
        >
          {children}
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-[11px] z-[90] h-[30px] w-[104px] -translate-x-1/2 rounded-full bg-black" />
        </div>
      </div>
      <div className="text-center leading-tight">
        <div className="text-[15px] font-semibold text-ink">{label}</div>
        <div className="text-[13px] text-ink-3">{sub}</div>
      </div>
    </div>
  );
}
