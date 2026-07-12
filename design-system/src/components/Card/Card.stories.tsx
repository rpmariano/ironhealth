import type { Meta, StoryObj } from '@storybook/react';
import { Card } from './Card';

const meta: Meta<typeof Card> = {
  title: 'Components/Card',
  component: Card,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: (args) => (
    <Card {...args} style={{ maxWidth: 340 }}>
      <p className="text-sm font-semibold text-white mb-1">Título do cartão</p>
      <p className="text-xs text-slate-400">Conteúdo genérico dentro de um Card do IronHealth.</p>
    </Card>
  ),
};

export const SmallPadding: Story = {
  args: { padding: 'sm' },
  render: (args) => (
    <Card {...args} style={{ maxWidth: 340 }}>
      <p className="text-xs text-slate-300">Padding reduzido (p-3).</p>
    </Card>
  ),
};
