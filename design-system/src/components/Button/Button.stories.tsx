import type { Meta, StoryObj } from '@storybook/react';
import { Camera, Plus, Trash2 } from 'lucide-react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  parameters: { layout: 'padded' },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'outline', 'danger'] },
  },
};
export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: { variant: 'primary', icon: Camera, children: 'Registar Refeição' },
};

export const Outline: Story = {
  args: { variant: 'outline', icon: Plus, children: 'Adicionar Refeição Manualmente' },
};

export const Danger: Story = {
  args: { variant: 'danger', icon: Trash2, children: 'Eliminar refeição' },
};

export const Disabled: Story = {
  args: { variant: 'primary', icon: Camera, children: 'A analisar...', disabled: true },
};
