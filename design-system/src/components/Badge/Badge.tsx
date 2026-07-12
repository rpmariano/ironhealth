import React from 'react';

export type BadgeTone = 'accent' | 'success' | 'danger' | 'neutral';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Tom semântico — accent (cor de sistema, ex: "Em breve"), success (dentro da meta), danger (excedido), neutral */
  tone?: BadgeTone;
}

const tones: Record<BadgeTone, string> = {
  accent: 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/30',
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  danger: 'bg-red-500/15 text-red-400 border-red-500/40',
  neutral: 'bg-neutral-800 text-slate-400 border-neutral-700',
};

export function Badge({ tone = 'neutral', className = '', children, ...rest }: BadgeProps) {
  return (
    <span
      className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border whitespace-nowrap ${tones[tone]} ${className}`.trim()}
      {...rest}
    >
      {children}
    </span>
  );
}
