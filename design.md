# AI Smart Stick Design System v2.0 - Liquid Glassmorphism

## 1. Overview
The new UI/UX will implement a full frosted blur "Liquid Glass" aesthetic inspired by iOS 26+ and modern web flows. It emphasizes deep background blurs, ambient lighting, high contrast typography, and interactive touch states.

## 2. Core Color Palette
- **Light Mode Background:** `#f0f4f8`
- **Dark Mode Background:** `#050508`
- Smooth `transition-colors duration-300` across background elements.

## 3. Glassmorphism Surfaces & Cards
**Light Mode:**
- Backgrounds: `bg-white/40` or `rgba(255, 255, 255, 0.45)`
- Blur & Saturation: `backdrop-blur-3xl saturate-150`
- Border: `border border-white/50` or `border-white/60`
- Shadow: Soft drop shadow `shadow-2xl`

**Dark Mode:**
- Backgrounds: `bg-white/5`, `rgba(18, 18, 26, 0.55)`, or `rgba(22, 22, 30, 0.95)`
- Blur & Saturation: `backdrop-blur-3xl saturate-150`
- Border: `border border-white/10` or `border-white/12`
- Shadow: `shadow-[0_15px_35px_rgba(0,0,0,0.4)]`

## 4. Typography
- **Font Family:** Maintain clear, readable sans-serif fonts, aligned with iOS.
- **Light Mode:** 
  - Primary text: `text-gray-900`
  - Secondary text: `text-gray-700`
  - Tertiary text: `text-gray-500`
- **Dark Mode:**
  - Primary text: `text-white`
  - Secondary text: `text-gray-300`
  - Tertiary text: `text-gray-400`
- **Accents:** Text gradient headings `bg-gradient-to-r text-transparent bg-clip-text`.
  - Light: `from-blue-600 to-purple-600`
  - Dark: `from-blue-400 to-purple-400`
- **Selection Color:** `selection:bg-purple-500 selection:text-white`

## 5. Atmosphere (Ambient Background)
- Absolute positioned, heavily blurred glowing orbs (`blur-[100px]` to `blur-[140px]`).
- Gradient palettes: `from-purple-600 to-pink-500`, `from-blue-600 to-cyan-400`, `from-indigo-500 to-violet-600`.
- Opacity:
  - Light Mode: `opacity-40` with `mix-blend-multiply`.
  - Dark Mode: `opacity-20` or `opacity-30` with `mix-blend-screen`.

## 6. Interactive Animations
- **Click Actions:** Ripple-like small blur and scale animations (Google Flow / iOS interactive buttons).
- Buttons use glass effects: `bg-white/40 dark:bg-white/10`. Hover states push opacity to `hover:bg-white/60 dark:hover:bg-white/20`.

## Implementation Strategy
1. **CSS Variables (`src/styles.css`):** Update the root tokens to use the new colors and transition effects. Modify the `.glass` utility to match the requested specs.
2. **Atmosphere (`src/components/Atmosphere.tsx`):** Replace the current drifting orbs with the new gradient setup, high blur, and mix-blend modes.
3. **Glass Primitives (`src/components/glass.tsx`):** Implement interactive button scaling, ripple/blur effects on press, mirroring the `interactive()` feel from `IOS.md`.
4. **App Colors (`src/App.tsx`, `src/features/...`):** Align typography classes (`text-gray-900`, `text-white`, etc.) across the app where custom color classes are manually specified.
