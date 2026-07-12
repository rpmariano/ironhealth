import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Chip } from './Chip';

const meta: Meta<typeof Chip> = {
  title: 'Components/Chip',
  component: Chip,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof Chip>;

export const Active: Story = { args: { active: true, children: 'Hoje' } };
export const Inactive: Story = { args: { active: false, children: 'Esta Semana' } };

export const RangeGroup: Story = {
  render: () => {
    const [active, setActive] = useState('hoje');
    const options = [
      { key: 'hoje', label: 'Hoje' },
      { key: 'semana', label: 'Esta Semana' },
      { key: 'mes', label: 'Este Mês' },
    ];
    return (
      <div className="flex gap-2">
        {options.map((o) => (
          <Chip key={o.key} active={active === o.key} onClick={() => setActive(o.key)}>
            {o.label}
          </Chip>
        ))}
      </div>
    );
  },
};

export const MealTypeGroup: Story = {
  render: () => {
    const [active, setActive] = useState('almoco');
    const options = [
      { key: 'pequeno-almoco', label: 'Pequeno-almoço' },
      { key: 'almoco', label: 'Almoço' },
      { key: 'lanche', label: 'Lanche' },
      { key: 'jantar', label: 'Jantar' },
      { key: 'ceia', label: 'Ceia' },
    ];
    return (
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Chip
            key={o.key}
            active={active === o.key}
            onClick={() => setActive(o.key)}
            className="rounded-full !py-1.5"
          >
            {o.label}
          </Chip>
        ))}
      </div>
    );
  },
};
