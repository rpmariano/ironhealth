import type { Meta, StoryObj } from '@storybook/react';
import { LayoutDashboard, CalendarDays } from 'lucide-react';
import { TabButton } from './TabButton';

const meta: Meta<typeof TabButton> = {
  title: 'Components/TabButton',
  component: TabButton,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof TabButton>;

export const Active: Story = { args: { icon: LayoutDashboard, label: 'Dashboard', active: true } };
export const Inactive: Story = { args: { icon: CalendarDays, label: 'Calendário', active: false } };

export const BottomNav: Story = {
  render: () => (
    <div
      className="grid grid-cols-2 bg-neutral-900/95 border-t border-neutral-800"
      style={{ width: 320 }}
    >
      <TabButton icon={LayoutDashboard} label="Dashboard" active={true} />
      <TabButton icon={CalendarDays} label="Calendário" active={false} />
    </div>
  ),
};
