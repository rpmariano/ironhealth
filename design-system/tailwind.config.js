/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx}', './.storybook/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        neutral: {
          950: '#09090b',
          900: '#18181b',
          800: '#27272a',
        },
      },
    },
  },
  plugins: [],
};
