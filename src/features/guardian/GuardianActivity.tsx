import { useState } from 'react';
import { motion } from 'motion/react';
import { Heart, Footprints, ShieldAlert, Activity as ActivityIcon } from 'lucide-react';
import { useFeed } from '../../core/sync/guardianFeed';
import { km, mins } from '../shared/labels';
import type { EventKind } from '../../core/types';
import { useNow } from '../../hooks/useNow';
import { Glass, Segmented, cx } from '../../components/glass';
import { EventRow, GHeader, GScreen, TopNav } from './parts';

const FILTERS: { value: 'all' | EventKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'safety', label: 'Safety' },
  { value: 'navigation', label: 'Walks' },
  { value: 'device', label: 'Stick' },
  { value: 'vision', label: 'Camera' },
];

export function GuardianActivity() {
  const now = useNow(5000);
  const f = useFeed();
  const events = f.activity;
  const name = f.userName || 'Your person';
  const [range, setRange] = useState<'today' | 'week'>('today');
  const [filter, setFilter] = useState<'all' | EventKind>('all');
  const since = range === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : now - 7 * 86_400_000;
  const inRange = events.filter((e) => e.ts >= since);
  const shown = filter === 'all' ? inRange : inRange.filter((e) => e.kind === filter);
  const walks = f.walks.filter((w) => w.startTime >= since);
  const distance = walks.reduce((a, w) => a + w.distanceM, 0);
  const duration = walks.reduce((a, w) => a + w.durationS, 0);
  const speed = distance > 50 && duration > 0 ? (distance / duration) * 3.6 : null;
  const obstacles = inRange.filter((e) => e.kind === 'safety' && e.title.startsWith('Obstacle')).length;
  const sos = inRange.filter((e) => e.title === 'SOS sent').length;
  // Bars: metres per hour (today) or per day (week), from real walk sessions only.
  const buckets = range === 'today' ? 24 : 7;
  const bars = Array.from({ length: buckets }, () => 0);
  for (const w of walks) {
    const idx = range === 'today' ? new Date(w.startTime).getHours() : 6 - Math.floor((now - w.startTime) / 86_400_000);
    if (idx >= 0 && idx < buckets) bars[idx] += w.distanceM;
  }
  const max = Math.max(1, ...bars);

  return (
    <GScreen>
      <TopNav />
      <GHeader title="Activity & Health" subtitle={`${name}'s ${range === 'today' ? 'day' : 'week'}`} />
      <div className="mb-4">
        <Segmented
          label="Time range"
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'week', label: 'This week' },
          ]}
        />
      </div>

      <div className="glass rounded-[28px] p-6 shadow-lg mb-4">
        <div className="flex justify-between items-start mb-6">
          <div>
            <p className="text-[14px] font-bold text-ink-3 uppercase tracking-widest">Walked</p>
            <p className="text-[32px] font-bold text-ink flex items-baseline gap-1 mt-1 leading-none">{km(distance)}</p>
            <p className="mt-1 text-[14px] text-ink-3">{walks.length ? `${mins(duration)} on foot${speed ? ` · ${speed.toFixed(1)} km/h average` : ''}` : 'No walks recorded'}</p>
          </div>
          <div className="p-3 bg-info/10 text-info rounded-full"><ActivityIcon size={24} /></div>
        </div>

        <div className="flex h-32 items-end gap-[3px]" role="img" aria-label={`Distance walked per ${range === 'today' ? 'hour' : 'day'}`}>
          {bars.map((m, i) => (
            <motion.div key={i} initial={{ height: 0 }} animate={{ height: `${Math.max(3, (m / max) * 100)}%` }} className={cx('flex-1 rounded-t-[4px]', m ? 'bg-teal' : 'bg-teal/20')} />
          ))}
        </div>
        <div className="flex justify-between text-[13px] font-bold text-ink-3 mt-3 px-1">
          {range === 'today' ? (<><span>12 AM</span><span>12 PM</span><span>11 PM</span></>) : (<><span>7 days ago</span><span>Today</span></>)}
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3">From {name}'s phone GPS. Noisy fixes and impossible jumps are excluded.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="glass rounded-[24px] p-5 flex flex-col gap-3 shadow-sm">
          <div className="p-3 bg-amber/10 text-amber rounded-full w-max"><Footprints size={24} /></div>
          <div>
            <p className="text-[14px] font-bold text-ink-2">Obstacles under 60 cm</p>
            <p className="text-[24px] font-bold text-ink leading-tight">{obstacles}</p>
          </div>
        </div>
        <div className="glass rounded-[24px] p-5 flex flex-col gap-3 shadow-sm">
          <div className="p-3 bg-sos/10 text-sos rounded-full w-max"><ShieldAlert size={24} /></div>
          <div>
            <p className="text-[14px] font-bold text-ink-2">SOS alerts</p>
            <p className="text-[24px] font-bold text-ink leading-tight">{sos}</p>
          </div>
        </div>
        <div className="glass rounded-[24px] p-5 flex flex-col gap-3 shadow-sm">
          <div className="p-3 bg-ink/5 text-ink-3 rounded-full w-max"><Heart size={24} /></div>
          <div>
            <p className="text-[14px] font-bold text-ink-2">Heart Rate</p>
            <p className="text-[17px] font-bold text-ink-3 leading-tight">Unavailable</p>
            <p className="text-[12px] text-ink-3">No heart-rate sensor</p>
          </div>
        </div>
        <div className="glass rounded-[24px] p-5 flex flex-col gap-3 shadow-sm">
          <div className="p-3 bg-teal/10 text-teal rounded-full w-max"><ActivityIcon size={24} /></div>
          <div>
            <p className="text-[14px] font-bold text-ink-2">Walks</p>
            <p className="text-[24px] font-bold text-ink leading-tight">{walks.length}</p>
          </div>
        </div>
      </div>

      <h3 className="text-[18px] font-bold text-ink px-1 mb-3 mt-6">Event Logs</h3>
      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 no-scrollbar" role="tablist" aria-label="Filter events">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cx('h-9 shrink-0 rounded-full px-4 text-[14px] font-semibold', filter === f.value ? 'chip-solid' : 'glass text-ink-2')}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Glass className="overflow-hidden rounded-[26px] [&>*+*]:border-t [&>*+*]:border-line">
        {shown.length ? shown.map((e) => <EventRow key={e.id} e={e} now={now} />) : <p className="px-4 py-6 text-center text-[15px] text-ink-3">Nothing here yet today.</p>}
      </Glass>
    </GScreen>
  );
}
