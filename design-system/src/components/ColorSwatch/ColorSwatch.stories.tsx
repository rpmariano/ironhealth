import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ColorSwatch } from './ColorSwatch';

const ACCENT_COLORS = [
  { key: 'blue1', label: 'Azul Céu', color: '#38bdf8' },
  { key: 'blue2', label: 'Azul Índigo', color: '#818cf8' },
  { key: 'pink', label: 'Rosa', color: '#f472b6' },
  { key: 'yellow', label: 'Amarelo', color: '#fbbf24' },
  { key: 'orange', label: 'Laranja', color: '#fb923c' },
  { key: 'green', label: 'Verde', color: '#4ade80' },
];

const meta: Meta<typeof ColorSwatch> = {
  title: 'Components/ColorSwatch',
  component: ColorSwatch,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof ColorSwatch>;

export const Single: Story = { args: { color: '#fb923c', label: 'Laranja', active: true } };

export const Picker: Story = {
  render: () => {
    const [selected, setSelected] = useState('orange');
    return (
      <div className="grid grid-cols-6 gap-2" style={{ maxWidth: 320 }}>
        {ACCENT_COLORS.map((c) => (
          <ColorSwatch
            key={c.key}
            color={c.color}
            label={c.label}
            active={selected === c.key}
            onClick={() => setSelected(c.key)}
          />
        ))}
      </div>
    );
  },
};
