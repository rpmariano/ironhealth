import React from 'react';

export interface ProgressBarProps {
  /** Valor atual (ex: calorias consumidas) */
  value: number;
  /** Valor máximo/meta */
  max: number;
  /** Cor do preenchimento quando dentro da meta (aceita hex ou var(--accent)) */
  color?: string;
  /** Força o estado "acima da meta" (vermelho), independentemente de value/max */
  over?: boolean;
  className?: string;
}

export function ProgressBar({ value, max, color = 'var(--accent)', over, className = '' }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const isOver = over ?? value > max;
  return (
    <div className={`w-full h-2 rounded-full bg-neutral-800 overflow-hidden ${className}`.trim()}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, background: isOver ? '#ef4444' : color }}
      />
    </div>
  );
}
