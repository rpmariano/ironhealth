import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface NavIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Ícone lucide-react */
  icon: LucideIcon;
  /** Legenda por baixo do ícone */
  label: string;
  /** Estado ativo — mostra o contorno na cor de sistema (não preenchimento sólido) */
  active?: boolean;
}

export function NavIconButton({ icon: Icon, label, active, className = '', ...rest }: NavIconButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`flex flex-col items-center gap-1 shrink-0 w-14 ${className}`.trim()}
      {...rest}
    >
      <span
        className="w-11 h-11 rounded-2xl flex items-center justify-center transition"
        style={
          active
            ? { background: '#18181b', border: '2px solid var(--accent)', color: 'var(--accent)' }
            : { background: '#18181b', border: '1px solid #27272a', color: '#71717a' }
        }
      >
        <Icon className="w-5 h-5" />
      </span>
      <span
        className="text-[10px] font-medium transition"
        style={{ color: active ? 'var(--accent)' : '#71717a' }}
      >
        {label}
      </span>
    </button>
  );
}
