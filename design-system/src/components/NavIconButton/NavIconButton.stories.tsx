import type { Meta, StoryObj } from '@storybook/react';
import { LayoutGrid, Utensils, Dumbbell, Footprints, Bot } from 'lucide-react';
import { NavIconButton } from './NavIconButton';

const meta: Meta<typeof NavIconButton> = {
  title: 'Components/NavIconButton',
  component: NavIconButton,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof NavIconButton>;

export const Active: Story = { args: { icon: Utensils, label: 'Nutrição', active: true } };
export const Inactive: Story = { args: { icon: Dumbbell, label: 'Ginásio', active: false } };

export const Strip: Story = {
  render: () => (
    <div className="flex items-start gap-3">
      <NavIconButton icon={LayoutGrid} label="Início" active={false} />
      <NavIconButton icon={Utensils} label="Nutrição" active={true} />
      <NavIconButton icon={Dumbbell} label="Ginásio" active={false} />
      <NavIconButton icon={Footprints} label="Corrida" active={false} />
      <NavIconButton icon={Bot} label="Coach" active={false} />
    </div>
  ),
};
