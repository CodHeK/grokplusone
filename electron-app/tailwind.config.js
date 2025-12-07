/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        midnight: '#0b1020',
        ink: '#0f172a',
      },
      boxShadow: {
        glow: '0 20px 70px rgba(59,130,246,0.35)',
      },
    },
  },
  plugins: [],
};
