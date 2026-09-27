import { useState } from 'react';
import { Send } from 'lucide-react';
import { useUI } from '../../core/store/ui';
import { useFeed, guardianActions } from '../../core/sync/guardianFeed';
import { toastGuardian } from '../../core/store/ui';
import { friendlyError } from '../../core/errors';
import { GlassButton, Sheet } from '../../components/glass';

const PRESETS = ["I'm on my way.", 'Call me when you can.', 'Wait there, I’m coming.', 'Lunch is ready, come home.'];

/** Guardian types, the stick user hears it in his earbuds. */
export function TalkSheet() {
  const open = useUI((s) => s.talkSheet);
  const name = useFeed((s) => s.userName) || 'them';
  const [text, setText] = useState('');
  const close = () => useUI.setState({ talkSheet: false });
  const send = (t: string) => {
    if (!t.trim()) return;
    void guardianActions.sendMessage(t.trim()).catch((e) => toastGuardian(`Not sent. ${friendlyError(e)}`));
    setText('');
    close();
  };
  return (
    <Sheet open={open} onClose={close} label={`Talk to ${name}`}>
      <h2 className="text-[24px] font-bold tracking-[-0.01em] text-ink">Talk to {name}</h2>
      <p className="mb-4 text-[15px] text-ink-3">The assistant reads it out on their phone.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => send(p)} className="glass h-10 rounded-full px-4 text-[14.5px] font-semibold text-ink-2">
            {p}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={`Write a message for ${name}`}
          aria-label={`Message for ${name}`}
          className="w-full resize-none rounded-[22px] border border-line bg-surface/70 p-4 text-[16px] text-ink outline-none placeholder:text-ink-3 focus:border-teal"
        />
        <GlassButton type="submit" variant="teal" size="lg" className="mt-3 w-full" disabled={!text.trim()}>
          <Send size={18} /> Send to {name}
        </GlassButton>
      </form>
    </Sheet>
  );
}
