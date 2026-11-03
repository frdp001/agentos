/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./renderer/index.html', './renderer/src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Hermes dark palette.
        base: {
          950: '#0b0d12',
          900: '#0f1219',
          800: '#151a23',
          700: '#1d2430',
          600: '#2a3342',
          500: '#3b4657',
        },
        ink: {
          DEFAULT: '#e6e9ef',
          muted: '#8b95a7',
          faint: '#5b6577',
        },
        accent: {
          DEFAULT: '#5b8cff',
          soft: '#2b3a63',
          glow: '#8fb0ff',
        },
        sentiment: {
          interested: '#34d399',
          unsubscribe: '#f87171',
          objection: '#fbbf24',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.7)',
      },
    },
  },
  plugins: [],
};
