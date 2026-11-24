import React from 'react';

type P = { size?: number; className?: string; title?: string };
const S = ({ size = 22, className, title, children, fill = 'none' }: P & { children: React.ReactNode; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}{children}
  </svg>
);

export const IHome = (p: P) => <S {...p}><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-5h-6v5H5.5A1.5 1.5 0 0 1 4 19z" /></S>;
export const ICalendar = (p: P) => <S {...p}><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" strokeWidth={2.4} /></S>;
export const IInsights = (p: P) => <S {...p}><path d="M4 20h16" /><path d="M7 16v-4M11 16V8M15 16v-6M19 16V5" /></S>;
export const IChat = (p: P) => <S {...p}><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-3.9A8 8 0 1 1 20 12z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" strokeWidth={2.4} /></S>;
// The gear's teeth reach the edges of the 24 box (1–23), while the other tab icons sit
// within about 3.5–20.5, so it's scaled down to match. The stroke is 1.7 / 0.8 so it ends up the same weight.
export const ISettings = (p: P) => <S {...p}><g transform="translate(12 12) scale(0.8) translate(-12 -12)" strokeWidth={2.125}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></g></S>;
export const IBottle = (p: P) => <S {...p}><path d="M10 2.5h4M9.5 5h5l-.5-2.5h-4z" /><path d="M9.5 5c-1.5 1-2.5 2.3-2.5 4v10.5A2 2 0 0 0 9 21.5h6a2 2 0 0 0 2-2V9c0-1.7-1-3-2.5-4" /><path d="M7 12h3M7 15h3" /></S>;
export const IBreast = (p: P) => <S {...p}><circle cx="12" cy="6.5" r="2.8" /><path d="M6 20c0-4 2.5-7.5 6-7.5s6 3.5 6 7.5" /><circle cx="12" cy="16" r="2.2" /></S>;
export const IFormula = (p: P) => <S {...p}><rect x="6" y="7" width="12" height="14" rx="2.5" /><path d="M8 3.5h8V7H8z" /><path d="M9.5 13h5M12 10.5v5" /></S>;
export const IPoo = (p: P) => <S {...p}><path d="M12 3.5c1.5 1 1.6 2.4 1 3.3 2.2 0 3.6 1.4 3.4 3.2 2 .4 3.1 1.9 2.8 3.6 1.4.8 1.9 2.3 1.4 3.6-.6 1.6-2.3 2.3-4.3 2.3H7.7c-2 0-3.7-.7-4.3-2.3-.5-1.3 0-2.8 1.4-3.6-.3-1.7.8-3.2 2.8-3.6-.2-1.8 1.2-3.2 3.4-3.2-.4-1.4.2-2.6 1-3.3z" /></S>;
export const IMoon = (p: P) => <S {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></S>;
export const ISparkle = (p: P) => <S {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></S>;
// Bebig Plus mark: a soft crown. Kept separate from ISparkle, which means AI and insights.
export const ICrown = (p: P) => <S {...p}><path d="M4.2 17.5 3 8.6l4.9 3.6L12 5.5l4.1 6.7L21 8.6l-1.2 8.9z" /><path d="M5 20.5h14" /></S>;
export const IPlus = (p: P) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const IMinus = (p: P) => <S {...p}><path d="M5 12h14" /></S>;
export const IChevron = (p: P) => <S {...p}><path d="m9 6 6 6-6 6" /></S>;
export const IBack = (p: P) => <S {...p}><path d="m15 6-6 6 6 6" /></S>;
export const IClock = (p: P) => <S {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></S>;
export const ITimer = (p: P) => <S {...p}><circle cx="12" cy="13.5" r="7.5" /><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5M19 6.5l1.5-1.5" /></S>;
export const IPause = (p: P) => <S {...p}><path d="M8.5 5v14M15.5 5v14" strokeWidth={2.4} /></S>;
export const IPlay = (p: P) => <S {...p} fill="currentColor"><path d="M8 5.5v13l10.5-6.5z" /></S>;
export const IStop = (p: P) => <S {...p} fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2" /></S>;
export const IBed = (p: P) => <S {...p}><path d="M3 18V7M3 14h18v4M21 14v-2.5A2.5 2.5 0 0 0 18.5 9H11v5" /><circle cx="7" cy="11" r="1.8" /></S>;
export const IBell = (p: P) => <S {...p}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></S>;
export const ISend = (p: P) => <S {...p}><path d="M5 12h13M13 6l6 6-6 6" /></S>;
export const IInfo = (p: P) => <S {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" strokeWidth={2.2} /></S>;
export const IUsers = (p: P) => <S {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><circle cx="17" cy="9" r="2.5" /><path d="M16.5 13.5c2.6 0 4.5 1.8 4.5 4.5" /></S>;
export const IChart = (p: P) => <S {...p}><path d="M4 4v16h16" /><path d="m7 15 4-4 3 2 5-6" /></S>;
export const IExport = (p: P) => <S {...p}><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" /><path d="M5 13v5.5A2 2 0 0 0 7 20.5h10a2 2 0 0 0 2-2V13" /></S>;
export const IShield = (p: P) => <S {...p}><path d="M12 3 5 6v5.5c0 4.3 3 7.7 7 9.5 4-1.8 7-5.2 7-9.5V6z" /><path d="m9 12 2 2 4-4" /></S>;
export const ISliders = (p: P) => <S {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></S>;
export const IEdit = (p: P) => <S {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></S>;
export const ITrash = (p: P) => <S {...p}><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /></S>;
export const IRuler = (p: P) => <S {...p}><rect x="2.5" y="8" width="19" height="8" rx="1.5" /><path d="M6.5 8v3M10 8v4M13.5 8v3M17 8v4" /></S>;
export const IScale = (p: P) => <S {...p}><rect x="3.5" y="4" width="17" height="16" rx="4" /><path d="M8.5 10a5 5 0 0 1 7 0l-2.5 2.5" /></S>;
export const ICloudOff = (p: P) => <S {...p}><path d="M3 3l18 18" /><path d="M7.5 7.6A5 5 0 0 0 7 17.5h10.4M18.6 16.9A3.5 3.5 0 0 0 17 10.5h-.5a6 6 0 0 0-6.2-4.4" /></S>;
export const ICheck = (p: P) => <S {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></S>;
export const IX = (p: P) => <S {...p}><path d="M6 6l12 12M18 6 6 18" /></S>;
export const IDrop = (p: P) => <S {...p}><path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5z" /></S>;
export const IHead = (p: P) => <S {...p}><circle cx="12" cy="12" r="8" /><path d="M4 12h16" strokeDasharray="2 2" /></S>;
