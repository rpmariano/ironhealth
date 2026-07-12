import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  parameters: { layout: 'padded' },
  argTypes: {
    tone: { control: 'select', options: ['accent', 'success', 'danger', 'neutral'] },
  },
};
export default meta;
type Story = StoryObj<typeof Badge>;

export const Success: Story = { args: { tone: 'success', children: 'restam 1670 kcal' } };
export const Danger: Story = { args: { tone: 'danger', children: '210 kcal acima' } };
export const Accent: Story = { args: { tone: 'accent', children: 'Em breve' } };
export const Neutral: Story = { args: { tone: 'neutral', children: 'Sem registos' } };

export const AllTones: Story = {
  render: () => (
    <div className="flex gap-2 flex-wrap">
      <Badge tone="accent">Em breve</Badge>
      <Badge tone="success">restam 1670 kcal</Badge>
      <Badge tone="danger">210 kcal acima</Badge>
      <Badge tone="neutral">Sem registos</Badge>
    </div>
  ),
};
