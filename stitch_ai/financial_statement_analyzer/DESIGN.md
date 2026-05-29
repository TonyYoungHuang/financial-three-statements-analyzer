---
name: Financial Statement Analyzer
colors:
  surface: '#fbf8fa'
  surface-dim: '#dcd9db'
  surface-bright: '#fbf8fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3f4'
  surface-container: '#f0edef'
  surface-container-high: '#eae7e9'
  surface-container-highest: '#e4e2e3'
  on-surface: '#1b1b1d'
  on-surface-variant: '#45474c'
  inverse-surface: '#303032'
  inverse-on-surface: '#f3f0f2'
  outline: '#75777d'
  outline-variant: '#c5c6cd'
  surface-tint: '#545f73'
  primary: '#091426'
  on-primary: '#ffffff'
  primary-container: '#1e293b'
  on-primary-container: '#8590a6'
  inverse-primary: '#bcc7de'
  secondary: '#0058be'
  on-secondary: '#ffffff'
  secondary-container: '#2170e4'
  on-secondary-container: '#fefcff'
  tertiary: '#1e1200'
  on-tertiary: '#ffffff'
  tertiary-container: '#35260c'
  on-tertiary-container: '#a38c6a'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d8e3fb'
  primary-fixed-dim: '#bcc7de'
  on-primary-fixed: '#111c2d'
  on-primary-fixed-variant: '#3c475a'
  secondary-fixed: '#d8e2ff'
  secondary-fixed-dim: '#adc6ff'
  on-secondary-fixed: '#001a42'
  on-secondary-fixed-variant: '#004395'
  tertiary-fixed: '#fadfb8'
  tertiary-fixed-dim: '#ddc39d'
  on-tertiary-fixed: '#271902'
  on-tertiary-fixed-variant: '#564427'
  background: '#fbf8fa'
  on-background: '#1b1b1d'
  surface-variant: '#e4e2e3'
typography:
  display-lg:
    fontFamily: IBM Plex Sans
    fontSize: 30px
    fontWeight: '600'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: IBM Plex Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  title-sm:
    fontFamily: IBM Plex Sans
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
  data-tabular:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 16px
  md: 24px
  lg: 32px
  xl: 48px
  container-max: 1440px
  gutter: 24px
---

## Brand & Style
The design system is anchored in the **Corporate / Modern** aesthetic, specifically tailored for high-stakes financial environments. The brand personality is authoritative, precise, and objective. It prioritizes information density without sacrificing clarity, ensuring that complex financial data—Balance Sheets, Income Statements, and Cash Flow Statements—are digestible and actionable.

The UI avoids decorative flourishes, opting instead for a "data-first" philosophy. Every pixel serves a functional purpose, utilizing a disciplined grid and refined typography to evoke a sense of institutional reliability and institutional-grade software.

## Colors
The color palette is engineered for professional trust and semantic clarity.
- **Navy Blue (#1E293B)** acts as the structural foundation, used for sidebars, primary navigation, and headers to establish authority.
- **Professional Blue (#3B82F6)** is reserved for interactive elements, indicating primary actions and focused states.
- **Functional Semantics:** Emerald Green, Amber, and Rose Red are used strictly for financial health indicators (e.g., positive cash flow vs. high debt-to-equity ratios).
- **Neutral Scales:** The background utilizes a very subtle gray to reduce eye strain during prolonged analysis, while pure white surfaces isolate specific data modules.

## Typography
This design system employs a multi-font strategy to differentiate narrative content from quantitative data. 
- **Headings:** Use **IBM Plex Sans** for its structured, corporate feel that remains legible at various weights.
- **Body Text:** **Inter** provides high readability for descriptive analysis and tooltips.
- **Numerical Data:** **JetBrains Mono** or Inter with tabular lining is utilized for financial tables to ensure that decimal points and digits align vertically, facilitating rapid cross-row comparison.
- **Hierarchy:** High contrast in weight is used between category labels and actual data points to guide the eye through dense reports.

## Layout & Spacing
The layout follows a **Fixed Grid** model for the main content area (max-width 1440px) to maintain a consistent reading experience for complex tables on large monitors.
- **Structure:** A 12-column grid with 24px gutters.
- **Rhythm:** A 4px baseline shift is used for internal component spacing, while larger 24px/32px gaps separate distinct data cards.
- **Desktop-First:** Navigation is primarily handled via a persistent left-hand sidebar (240px) to allow for deep nested structures (e.g., switching between different fiscal years or subsidiaries).
- **Margins:** Page margins are set to 32px on desktop to provide visual "breathing room" around dense data modules.

## Elevation & Depth
Depth is communicated through **Tonal Layers** and extremely subtle **Ambient Shadows**. This design system avoids high-elevation shadows to keep the interface feeling flat and "close to the paper," mimicking professional financial reports.
- **Level 0 (Background):** #F8FAFC.
- **Level 1 (Cards/Modules):** Pure white surface with a 1px border (#E2E8F0) and a soft 4px blur shadow at 5% opacity.
- **Level 2 (Dropdowns/Modals):** Pure white with a 12px blur shadow at 10% opacity to indicate temporary interaction.
- **In-set Depth:** Input fields and data cells use a subtle inner border rather than shadows to indicate interactability.

## Shapes
The shape language is conservative and disciplined. 
- **Standard Radius:** A 4px (soft) radius is the default for most components (buttons, inputs) to maintain a modern but serious tone.
- **Card Radius:** Cards use an 8px radius (`rounded-lg`) to gently soften the large blocks of data.
- **Strictness:** Circular elements are reserved exclusively for status indicators (dots) and user avatars to ensure they stand out against the predominantly rectangular grid.

## Components
- **Buttons:** Primary buttons use the Navy Blue background with white text. Ghost buttons use Professional Blue text for secondary actions like "Export" or "Filter."
- **Data Tables:** Clean, horizontal-only borders (#F1F5F9). Row hovering is highlighted with a very pale blue (#EFF6FF). Column headers use "label-caps" typography.
- **Status Tags:** Pills with low-saturation backgrounds and high-saturation text (e.g., Success: Light Green bg / Emerald Green text) to signify risk levels or audit status.
- **Step Indicators:** A slim horizontal line with numbered nodes, using Navy Blue for completed steps and Professional Blue for the active state.
- **Cards:** White backgrounds, 8px border radius, and a 1px Slate-200 border. Titles are always top-aligned with optional right-aligned "Action" links.
- **Input Fields:** Clear labels above the field, using a 1px gray border that shifts to Professional Blue on focus.
- **Iconography:** 2px stroke width, minimalist outline icons. Icons are used sparingly as anchors next to text labels (e.g., a "Cloud" icon next to "Upload Statement").