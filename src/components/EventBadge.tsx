import type { EventNotice } from '../utils/marketEvents';

const TONE_STYLES: Record<EventNotice['tone'], { color: string; background: string; border: string }> = {
  danger: { color: 'var(--accent-red)', background: 'rgba(244, 63, 94, 0.15)', border: 'rgba(244, 63, 94, 0.4)' },
  warning: { color: '#eab308', background: 'rgba(234, 179, 8, 0.15)', border: 'rgba(234, 179, 8, 0.35)' },
  info: { color: 'var(--accent-blue)', background: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.25)' },
};

export default function EventBadge({ notice }: { notice: EventNotice | null }) {
  if (!notice) return null;
  const tone = TONE_STYLES[notice.tone];
  return (
    <span
      title={notice.title}
      style={{
        fontSize: '0.52rem',
        fontWeight: '800',
        padding: '1px 4px',
        borderRadius: '3px',
        whiteSpace: 'nowrap',
        letterSpacing: '0.3px',
        color: tone.color,
        background: tone.background,
        border: `1px solid ${tone.border}`,
      }}
    >
      {notice.label}
    </span>
  );
}
