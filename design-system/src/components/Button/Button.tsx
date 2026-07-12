import React from 'react';
import type { LucideIcon } from 'lucide-react';

export type ButtonVariant = 'primary' | 'outline' | 'danger';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Estilo visual — primary (ação principal, cor de sistema), outline (secundária, tracejada) ou danger (destrutiva) */
  variant?: ButtonVariant;
  /** Ícone lucide-react opcional, mostrado antes do texto */
  icon?: LucideIcon;
  /** Ocupa a largura total do contentor (comportamento por defeito, como no IronHealth) */
  fullWidth?: boolean;
}

const base =
  'text-sm rounded-xl py-2.5 flex items-center justify-center gap-1.5 active:scale-[0.98] transition disabled:opacity-40';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--accent)] text-neutral-950 font-bold',
  outline:
    'border-2 border-dashed border-neutral-700 hover:border-[var(--accent)]/50 text-slate-400 hover:text-[var(--accent)] font-semibold',
  danger: 'border border-red-500/40 text-red-400 font-semibold',
};

export function Button({
  variant = 'primary',
  icon: Icon,
  fullWidth = true,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`${base} ${variants[variant]} ${fullWidth ? 'w-full' : ''} ${className}`.trim()}
      {...rest}
    >
      {Icon && <Icon className="w-4 h-4" />}
      {children}
    </button>
  );
}
