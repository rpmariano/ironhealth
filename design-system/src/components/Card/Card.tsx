import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Espaçamento interno — 'md' (por defeito, p-4), 'sm' (p-3) ou 'none' */
  padding?: 'md' | 'sm' | 'none';
}

const paddings: Record<NonNullable<CardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
};

export function Card({ padding = 'md', className = '', children, ...rest }: CardProps) {
  return (
    <div className={`ihui-card rounded-2xl ${paddings[padding]} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
