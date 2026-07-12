import type { Meta, StoryObj } from '@storybook/react';
import { ProgressBar } from './ProgressBar';

const meta: Meta<typeof ProgressBar> = {
  title: 'Components/ProgressBar',
  component: ProgressBar,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof ProgressBar>;

export const Accent: Story = {
  render: (args) => (
    <div style={{ width: 260 }}>
      <ProgressBar {...args} />
    </div>
  ),
  args: { value: 330, max: 2000 },
};

export const Protein: Story = {
  render: (args) => (
    <div style={{ width: 260 }}>
      <ProgressBar {...args} />
    </div>
  ),
  args: { value: 62, max: 150, color: '#10b981' },
};

export const Over: Story = {
  render: (args) => (
    <div style={{ width: 260 }}>
      <ProgressBar {...args} />
    </div>
  ),
  args: { value: 2100, max: 2000 },
};
