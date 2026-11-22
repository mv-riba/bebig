import React, { useEffect, useRef, useState } from 'react';
import { useBaby } from '../ui/hooks';
import { useStore, appendChat, chatKey, uuid, nowIso, clearChat } from '../lib/store';
import { answer, SUGGESTIONS } from '../lib/assistant';
import { buildInsights } from '../lib/insights';
import { ISparkle, ISend } from '../ui/icons';
import { syncMode } from '../lib/sync';
import { usePlus, PlusBadge, PlusLink, PlusNote } from '../ui/plus';
import { LIMITS } from '../lib/plans';

export function Assistant() {
  const ctx = useBaby(); const plus = usePlus();
  const msgs = useStore(s => (ctx ? s.chats[chatKey(ctx.baby.baby_id)] : null) ?? []);
  const [q, setQ] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }, [msgs.length]);
  if (!ctx || !plus) return null;
  const first = ctx.baby.name.split(' ')[0];
  const sugg = SUGGESTIONS.map(s => s.replace('my baby', first));

  const ask = async (text: string) => {
    if (!text.trim()) return;
    setQ('');
    let replies: { kind: 'fact' | 'estimate' | 'safety' | 'info' | 'plus'; content: string }[] = answer(text, ctx.data, ctx.growth, ctx.prefs.time_format, Date.now(), { trackers: ctx.allTrackers, extras: ctx.extras });
    // predictions are Plus; facts from the records and health guidance are always free
    if (!plus.can('predictions')) replies = replies.map(r => r.kind === 'estimate' ? { kind: 'plus' as const, content: `Estimating what comes next is part of Bebig Plus. ${plus.status.trial_eligible ? `You can try it free for ${LIMITS.trial_days} days.` : 'You can still ask about anything you’ve logged, like the last feed or yesterday’s sleep.'}` } : r);
    if (syncMode() === 'remote' && ctx.prefs.ai_consent && plus.can('ai_phrasing') && navigator.onLine) {
      const { phraseAnswer } = await import('../lib/supabase');
      replies = await Promise.all(replies.map(async r => r.kind === 'safety' || r.kind === 'plus' ? r : { ...r, content: await phraseAnswer(ctx.baby.baby_id, text, r.content, r.kind) }));
    }
    appendChat(ctx.baby.baby_id, [
      { id: uuid(), role: 'user', content: text.trim(), created_at: nowIso() },
      ...replies.map(r => ({ id: uuid(), role: 'assistant' as const, content: r.content, kind: r.kind, created_at: nowIso() })),
    ]);
  };

  const intro = (() => {
    const rep = buildInsights(ctx.data, ctx.prefs.time_format);
    const o = rep.observations.find(x => x.insight_id === 'sleep-nap-window') ?? rep.observations[0];
    return o ? `Based on the last ${rep.daysWithData} days of records: ${o.description}` : `Hi! I can answer questions about ${first}’s recorded feeds, sleep, bowel movements and growth.`;
  })();

  return (
    <div className="screen assistant">
      <header className="screen-head"><span /><h1>AI Assistant</h1>{msgs.length ? <button className="link small" onClick={() => clearChat(ctx.baby.baby_id)}>Clear</button> : <ISparkle className="spark" />}</header>
      <div className="chat" role="log" aria-live="polite">
        <div className="msg bot"><span className="bot-av" aria-hidden="true"><ISparkle size={18} /></span><div className="bubble">{intro}<br /><br />What would you like to know?</div></div>
        {msgs.map(m => m.role === 'user'
          ? <div key={m.id} className="msg me"><div className="bubble">{m.content}</div></div>
          : <div key={m.id} className="msg bot"><span className="bot-av" aria-hidden="true"><ISparkle size={18} /></span>
            <div className={`bubble kind-${m.kind}`}>{m.kind === 'estimate' && <span className="tag">Estimate <PlusBadge /></span>}{m.kind === 'plus' && <span className="tag"><PlusBadge /></span>}{m.kind === 'fact' && <span className="tag tag-fact">From your records</span>}{m.kind === 'safety' && <span className="tag tag-safety">Health question</span>}{m.content.split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}{m.kind === 'plus' && <><br /><PlusLink /></>}</div></div>)}
        <div ref={end} />
      </div>
      <div className="chat-foot">
        <div className="sugg">{sugg.slice(0, msgs.length ? 4 : 8).map(s => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}</div>
        <form className="ask" onSubmit={e => { e.preventDefault(); ask(q); }}>
          <input aria-label="Ask a question" placeholder="Ask a question…" value={q} onChange={e => setQ(e.target.value)} />
          <button className="send" aria-label="Send" disabled={!q.trim()}><ISend size={20} /></button>
        </form>
        {!plus.status.plus && <PlusNote>Questions about your records are free. Predictions and friendlier AI-written answers are part of Bebig Plus.</PlusNote>}
        <p className="muted tiny center">Answers are calculated from your records. Not medical advice.</p>
      </div>
    </div>
  );
}
