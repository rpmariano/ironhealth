import React from 'react';

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Estado selecionado — preenche com a cor de sistema */
  active?: boolean;
}

export function Chip({ active, className = '', style, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`border rounded-xl py-2 px-3 text-xs transition ${
        active ? 'font-bold' : 'font-semibold border-neutral-700 text-slate-300'
      } ${className}`.trim()}
      style={
        active
          ? { background: 'var(--accent)', color: '#09090b', borderColor: 'var(--accent)', ...style }
          : style
      }
      {...rest}
    >
      {children}
    </button>
  );
}
