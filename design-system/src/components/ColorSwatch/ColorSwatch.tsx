import React from 'react';

export interface ColorSwatchProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Cor a mostrar (hex) */
  color: string;
  /** Estado selecionado — mostra o anel de destaque */
  active?: boolean;
  /** Nome da cor, usado como title/tooltip */
  label?: string;
}

export function ColorSwatch({ color, active, label, className = '', ...rest }: ColorSwatchProps) {
  return (
    <button
      type="button"
      title={label}
      aria-pressed={active}
      className={`ihui-accent-swatch ${active ? 'active' : ''} aspect-square w-11 rounded-full transition active:scale-90 ${className}`.trim()}
      style={{ background: color, color }}
      {...rest}
    />
  );
}
