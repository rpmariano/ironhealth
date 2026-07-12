import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface TabButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Ícone lucide-react */
  icon: LucideIcon;
  /** Legenda por baixo do ícone */
  label: string;
  /** Estado ativo — cor de texto/ícone na cor de sistema */
  active?: boolean;
}

export function TabButton({ icon: Icon, label, active, className = '', ...rest }: TabButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition ${className}`.trim()}
      style={{ color: active ? 'var(--accent)' : '#71717a' }}
      {...rest}
    >
      <Icon className="w-5 h-5" />
      {label}
    </button>
  );
}
